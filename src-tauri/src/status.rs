//! running/waiting/stopped detection (SPEC.md §4). Phase 2 implements.
//!
//! running → waiting when, for an ON session:
//!  1. BEL (0x07) or OSC 9 / OSC 777 notification sequence appears in output, or
//!  2. ≥ WAITING_IDLE_MS of silence immediately follows an output burst.
//!
//! Any output or user keystroke: waiting → running. Process exit: → stopped.
//!
//! This module also owns the waiting-count side effects: `attention:count`
//! event, dock/taskbar badge, optional OS notification (settings.notify_on_waiting).

#![allow(dead_code)] // The PTY integration is implemented by a separate Phase 2 task.

pub const WAITING_IDLE_MS: u64 = 3000;

use crate::models::Status;
use std::time::{Duration, Instant};

const BEL: u8 = 0x07;

// Fixed-size parser state carries split OSC sequences without retaining notification payloads.
#[derive(Default)]
enum OutputParser {
    #[default]
    Normal,
    Escape,
    OscCode {
        digits: [u8; 3],
        len: usize,
    },
    Notification,
    NotificationEscape,
}

/// Per-session detector state machine, fed by the PTY reader thread.
pub struct StatusDetector {
    status: Status,
    last_output_at: Option<Instant>,
    parser: OutputParser,
}

impl Default for StatusDetector {
    fn default() -> Self {
        Self {
            status: Status::Running,
            last_output_at: None,
            parser: OutputParser::Normal,
        }
    }
}

impl StatusDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of PTY output; returns Some(new_status) on a transition.
    pub fn on_output(&mut self, chunk: &[u8]) -> Option<Status> {
        self.on_output_at(chunk, Instant::now())
    }

    /// Time-injected output handler for deterministic state-machine tests.
    pub fn on_output_at(&mut self, chunk: &[u8], now: Instant) -> Option<Status> {
        if chunk.is_empty() || self.status == Status::Stopped {
            return None;
        }

        let initial_status = self.status;
        let final_status = self.parse_output(chunk);
        self.status = final_status;

        if final_status == Status::Waiting {
            self.last_output_at = None;
        } else {
            self.last_output_at = Some(now);
        }

        (final_status != initial_status).then_some(final_status)
    }

    /// Feed a user keystroke (write_pty).
    pub fn on_input(&mut self) -> Option<Status> {
        self.on_input_at(Instant::now())
    }

    /// Time-injected input handler matching the output/tick test API.
    pub fn on_input_at(&mut self, _now: Instant) -> Option<Status> {
        if self.status == Status::Stopped {
            return None;
        }

        self.last_output_at = None;
        self.transition_to(Status::Running)
    }

    /// Called by a timer tick to detect idle-after-burst.
    pub fn on_tick(&mut self) -> Option<Status> {
        self.on_tick_at(Instant::now())
    }

    /// Time-injected tick handler for exact idle-boundary tests.
    pub fn on_tick_at(&mut self, now: Instant) -> Option<Status> {
        let idle_boundary = Duration::from_millis(WAITING_IDLE_MS);
        let has_been_idle = self
            .last_output_at
            .and_then(|last_output_at| now.checked_duration_since(last_output_at))
            .is_some_and(|elapsed| elapsed >= idle_boundary);

        if self.status == Status::Running && has_been_idle {
            self.last_output_at = None;
            return self.transition_to(Status::Waiting);
        }

        None
    }

    /// Mark the process stopped; stopped is terminal for this detector instance.
    pub fn on_exit(&mut self) -> Option<Status> {
        self.on_exit_at(Instant::now())
    }

    /// Time-injected exit handler matching the output/input/tick test API.
    pub fn on_exit_at(&mut self, _now: Instant) -> Option<Status> {
        self.last_output_at = None;
        self.parser = OutputParser::Normal;
        self.transition_to(Status::Stopped)
    }

    fn parse_output(&mut self, chunk: &[u8]) -> Status {
        // Later semantic events win so a prompt after a notification recovers to running.
        let mut final_status = Status::Running;

        for &byte in chunk {
            if byte == BEL {
                self.parser = OutputParser::Normal;
                final_status = Status::Waiting;
                continue;
            }

            self.parser = match std::mem::take(&mut self.parser) {
                OutputParser::Normal => {
                    final_status = Status::Running;
                    if byte == b'\x1b' {
                        OutputParser::Escape
                    } else {
                        OutputParser::Normal
                    }
                }
                OutputParser::Escape => {
                    if byte == b']' {
                        OutputParser::OscCode {
                            digits: [0; 3],
                            len: 0,
                        }
                    } else if byte == b'\x1b' {
                        OutputParser::Escape
                    } else {
                        OutputParser::Normal
                    }
                }
                OutputParser::OscCode {
                    mut digits,
                    mut len,
                } => {
                    if byte.is_ascii_digit() && len < digits.len() {
                        digits[len] = byte;
                        len += 1;
                        OutputParser::OscCode { digits, len }
                    } else if byte == b';' && matches!(&digits[..len], b"9" | b"777") {
                        OutputParser::Notification
                    } else if byte == b'\x1b' {
                        OutputParser::Escape
                    } else {
                        OutputParser::Normal
                    }
                }
                OutputParser::Notification => {
                    if byte == b'\x1b' {
                        OutputParser::NotificationEscape
                    } else {
                        OutputParser::Notification
                    }
                }
                OutputParser::NotificationEscape => {
                    if byte == b'\\' {
                        final_status = Status::Waiting;
                        OutputParser::Normal
                    } else if byte == b'\x1b' {
                        OutputParser::NotificationEscape
                    } else {
                        OutputParser::Notification
                    }
                }
            };
        }

        final_status
    }

    fn transition_to(&mut self, next: Status) -> Option<Status> {
        if self.status == next {
            return None;
        }

        self.status = next;
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Status;
    use std::time::{Duration, Instant};

    fn milliseconds(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn bell_transitions_running_to_waiting_immediately() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(
            detector.on_output_at(b"done\x07", now),
            Some(Status::Waiting)
        );
    }

    #[test]
    fn osc_9_transitions_running_to_waiting_immediately() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(
            detector.on_output_at(b"\x1b]9;finished\x1b\\", now),
            Some(Status::Waiting)
        );
    }

    #[test]
    fn osc_777_transitions_running_to_waiting_immediately() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(
            detector.on_output_at(b"\x1b]777;notify;Anchor;finished\x1b\\", now),
            Some(Status::Waiting)
        );
    }

    #[test]
    fn notification_sequences_are_detected_across_output_chunks() {
        let now = Instant::now();
        let mut osc_9 = StatusDetector::new();
        let mut osc_777 = StatusDetector::new();

        assert_eq!(osc_9.on_output_at(b"prefix\x1b]", now), None);
        assert_eq!(
            osc_9.on_output_at(b"9;finished", now + milliseconds(1)),
            None
        );
        assert_eq!(
            osc_9.on_output_at(b"\x1b\\", now + milliseconds(2)),
            Some(Status::Waiting)
        );
        assert_eq!(osc_777.on_output_at(b"\x1b]77", now), None);
        assert_eq!(
            osc_777.on_output_at(b"7;notify", now + milliseconds(1)),
            None
        );
        assert_eq!(
            osc_777.on_output_at(b"\x07", now + milliseconds(2)),
            Some(Status::Waiting)
        );
    }

    #[test]
    fn incomplete_osc_notifications_do_not_transition_without_a_terminator() {
        let now = Instant::now();
        let mut osc_9 = StatusDetector::new();
        let mut osc_777 = StatusDetector::new();

        assert_eq!(osc_9.on_output_at(b"\x1b]9;unfinished", now), None);
        assert_eq!(
            osc_777.on_output_at(b"\x1b]777;notify;unfinished", now),
            None
        );
        assert_eq!(osc_9.status, Status::Running);
        assert_eq!(osc_777.status, Status::Running);
    }

    #[test]
    fn notification_followed_by_ordinary_output_finishes_running() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();
        assert_eq!(detector.on_output_at(b"\x07", now), Some(Status::Waiting));

        assert_eq!(
            detector.on_output_at(b"\x1b]9;done\x1b\\prompt", now + milliseconds(1)),
            Some(Status::Running)
        );
        assert_eq!(detector.status, Status::Running);
    }

    #[test]
    fn ordinary_output_followed_by_notification_finishes_waiting() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(
            detector.on_output_at(b"finishing\x1b]777;notify;done\x1b\\", now),
            Some(Status::Waiting)
        );
        assert_eq!(detector.status, Status::Waiting);
    }

    #[test]
    fn split_terminator_preserves_output_ordering() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_output_at(b"\x1b]9;done\x1b", now), None);
        assert_eq!(
            detector.on_output_at(b"\\prompt", now + milliseconds(1)),
            None
        );
        assert_eq!(detector.status, Status::Running);
    }

    #[test]
    fn idle_after_burst_transitions_at_exact_boundary() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_output_at(b"working", now), None);
        assert_eq!(
            detector.on_tick_at(now + milliseconds(WAITING_IDLE_MS)),
            Some(Status::Waiting)
        );
    }

    #[test]
    fn idle_after_burst_is_a_no_op_before_boundary() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_output_at(b"working", now), None);
        assert_eq!(
            detector.on_tick_at(now + milliseconds(WAITING_IDLE_MS - 1)),
            None
        );
    }

    #[test]
    fn output_and_input_each_recover_waiting_to_running() {
        let now = Instant::now();
        let mut output_detector = StatusDetector::new();
        let mut input_detector = StatusDetector::new();
        assert_eq!(
            output_detector.on_output_at(b"\x07", now),
            Some(Status::Waiting)
        );
        assert_eq!(
            input_detector.on_output_at(b"\x07", now),
            Some(Status::Waiting)
        );

        assert_eq!(
            output_detector.on_output_at(b"more", now + milliseconds(1)),
            Some(Status::Running)
        );
        assert_eq!(
            input_detector.on_input_at(now + milliseconds(1)),
            Some(Status::Running)
        );
    }

    #[test]
    fn repeated_events_do_not_emit_duplicate_transitions() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_output_at(b"\x07", now), Some(Status::Waiting));
        assert_eq!(detector.on_output_at(b"\x07", now), None);
        assert_eq!(detector.on_input_at(now), Some(Status::Running));
        assert_eq!(detector.on_input_at(now), None);
    }

    #[test]
    fn input_while_running_cancels_armed_idle_until_new_output() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_output_at(b"working", now), None);
        assert_eq!(detector.on_input_at(now + milliseconds(1)), None);
        assert_eq!(
            detector.on_tick_at(now + milliseconds(WAITING_IDLE_MS + 1)),
            None
        );
        assert_eq!(
            detector.on_output_at(b"new burst", now + milliseconds(WAITING_IDLE_MS + 2)),
            None
        );
        assert_eq!(
            detector.on_tick_at(now + milliseconds(WAITING_IDLE_MS * 2 + 2)),
            Some(Status::Waiting)
        );
    }

    #[test]
    fn empty_output_does_not_arm_idle_detection() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_output_at(b"", now), None);
        assert_eq!(
            detector.on_tick_at(now + milliseconds(WAITING_IDLE_MS)),
            None
        );
    }

    #[test]
    fn exit_transitions_to_stopped_once_and_stopped_is_terminal() {
        let now = Instant::now();
        let mut detector = StatusDetector::new();

        assert_eq!(detector.on_exit_at(now), Some(Status::Stopped));
        assert_eq!(detector.on_exit_at(now), None);
        assert_eq!(detector.on_output_at(b"output", now), None);
        assert_eq!(detector.on_input_at(now), None);
        assert_eq!(
            detector.on_tick_at(now + milliseconds(WAITING_IDLE_MS)),
            None
        );
        assert_eq!(detector.status, Status::Stopped);
    }
}
