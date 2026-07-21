//! running/waiting/stopped detection (SPEC.md §4). Phase 2 implements.
//!
//! running → waiting when, for an ON session:
//!  1. BEL (0x07) or OSC 9 / OSC 777 notification sequence appears in output, or
//!  2. ≥ WAITING_IDLE_MS of silence immediately follows an output burst.
//! Any output or user keystroke: waiting → running. Process exit: → stopped.
//!
//! This module also owns the waiting-count side effects: `attention:count`
//! event, dock/taskbar badge, optional OS notification (settings.notify_on_waiting).

#![allow(dead_code)] // Phase 1 skeleton

pub const WAITING_IDLE_MS: u64 = 3000;

/// Per-session detector state machine, fed by the PTY reader thread.
#[derive(Default)]
pub struct StatusDetector {}

impl StatusDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of PTY output; returns Some(new_status) on a transition.
    pub fn on_output(&mut self, chunk: &[u8]) -> Option<crate::models::Status> {
        let _ = chunk;
        None
    }

    /// Feed a user keystroke (write_pty).
    pub fn on_input(&mut self) -> Option<crate::models::Status> {
        None
    }

    /// Called by a timer tick to detect idle-after-burst.
    pub fn on_tick(&mut self) -> Option<crate::models::Status> {
        None
    }
}
