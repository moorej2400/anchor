//! Owns the portable-pty boundary and exposes Tauri-independent events.
//!
//! Process waiting, output draining, status detection, and control operations
//! run on separate threads so a blocked PTY read cannot prevent process exit or
//! graceful shutdown from completing.

#![allow(dead_code)] // Command wiring is completed by a separate Phase 2 task.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::adapters::SpawnSpec;
use crate::models::{Settings, Status};
use crate::status::StatusDetector;

const OUTPUT_BATCH_MAX_LATENCY: Duration = Duration::from_millis(16);
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const READER_POLL_INTERVAL: Duration = Duration::from_millis(4);
const STATUS_TICK_INTERVAL: Duration = Duration::from_millis(10);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// Recent output retained per live session so a reloaded webview can be resent
/// what it missed. The frontend's xterm buffer is otherwise the only copy, and
/// it dies with the page (SPEC.md §8).
const RECENT_OUTPUT_MAX_BYTES: usize = 256 * 1024;
/// Trim only once the buffer has run this far past the cap, so a busy session
/// pays for the memmove occasionally rather than on every batch.
const RECENT_OUTPUT_TRIM_AT: usize = RECENT_OUTPUT_MAX_BYTES + 64 * 1024;
const NOT_FOUND: &str = "PTY_NOT_FOUND: no live PTY for session";

/// Event payload consumed by the Tauri adapter or by tests without a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Output {
        session_id: String,
        data: String,
    },
    Status {
        session_id: String,
        status: Status,
        exit_code: Option<i32>,
    },
}

type EventCallback = Arc<dyn Fn(PtyEvent) + Send + Sync + 'static>;

#[cfg(unix)]
type PtyReader = std::fs::File;
#[cfg(windows)]
type PtyReader = Box<dyn Read + Send>;

struct SessionRuntime {
    live: AtomicBool,
    stopped_emitted: AtomicBool,
    events_complete: AtomicBool,
    reader_cancel: AtomicBool,
    reader_complete: AtomicBool,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    detector: Mutex<StatusDetector>,
    /// Everything the session has printed lately, capped. Output is emitted
    /// while this lock is held, so a replay and the live stream can never
    /// interleave or duplicate: a chunk is either inside the replayed snapshot
    /// or emitted strictly after it.
    recent: Mutex<Vec<u8>>,
    process_id: Option<u32>,
    callback: EventCallback,
}

#[derive(Clone)]
pub struct PtyHandle {
    runtime: Arc<SessionRuntime>,
}

/// Registry of PTYs keyed by Anchor session ID.
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtyHandle>>,
    callback: EventCallback,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::with_callback(|_| {})
    }

    pub fn with_callback(callback: impl Fn(PtyEvent) + Send + Sync + 'static) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            callback: Arc::new(callback),
        }
    }

    pub fn spawn(
        &self,
        session_id: impl Into<String>,
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
        settings: &Settings,
    ) -> Result<(), String> {
        let session_id = session_id.into();
        if cols == 0 || rows == 0 {
            return Err("PTY_SIZE_INVALID: terminal dimensions must be non-zero".into());
        }

        // Keep the reservation lock through child creation so two launch callers
        // cannot both pass validation and orphan one of the spawned processes.
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        if sessions
            .get(&session_id)
            .is_some_and(|handle| !handle.runtime.events_complete.load(Ordering::Acquire))
        {
            return Err("PTY_ALREADY_LIVE: session already has a live PTY".into());
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "PTY_OPEN_FAILED: could not open a terminal".to_string())?;
        let reader = make_reader(pair.master.as_ref())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| "PTY_OPEN_FAILED: could not create terminal writer".to_string())?;

        let child_path = child_search_path(&spec, settings);
        let child_terminal_type = child_terminal_type(settings);
        let mut command = CommandBuilder::new(&spec.program);
        command.args(&spec.args);
        command.cwd(&spec.cwd);
        for env in &settings.env_vars {
            command.env(&env.key, &env.value);
        }
        if let Some(path) = child_path {
            command.env("PATH", path);
        }
        // Launch Services commonly supplies TERM=dumb, but every managed
        // process runs inside a real PTY rendered by xterm.js. Normalize only
        // missing/dumb values so interactive CLIs enable their TUI.
        command.env("TERM", child_terminal_type);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| "PTY_SPAWN_FAILED: could not spawn session process".to_string())?;
        let process_id = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);

        let runtime = Arc::new(SessionRuntime {
            live: AtomicBool::new(true),
            stopped_emitted: AtomicBool::new(false),
            events_complete: AtomicBool::new(false),
            reader_cancel: AtomicBool::new(false),
            reader_complete: AtomicBool::new(false),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            detector: Mutex::new(StatusDetector::new()),
            recent: Mutex::new(Vec::new()),
            process_id,
            callback: Arc::clone(&self.callback),
        });
        sessions.insert(
            session_id.clone(),
            PtyHandle {
                runtime: Arc::clone(&runtime),
            },
        );
        drop(sessions);

        (self.callback)(PtyEvent::Status {
            session_id: session_id.clone(),
            status: Status::Running,
            exit_code: None,
        });

        let (reader_sender, reader_receiver) = mpsc::channel();
        spawn_reader(reader, Arc::clone(&runtime), reader_sender.clone());
        spawn_dispatcher(session_id.clone(), Arc::clone(&runtime), reader_receiver);
        spawn_waiter(session_id, runtime, child, reader_sender);
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let runtime = self.live_runtime(session_id)?;
        {
            let mut writer = runtime.writer.lock().map_err(lock_error)?;
            let writer = writer.as_mut().ok_or_else(|| NOT_FOUND.to_string())?;
            writer
                .write_all(data)
                .and_then(|_| writer.flush())
                .map_err(|_| "PTY_WRITE_FAILED: could not write to terminal".to_string())?;
        }

        // Status callbacks are external and may synchronously write again.
        let transition = runtime.detector.lock().map_err(lock_error)?.on_input();
        if let Some(status) = transition {
            (runtime.callback)(PtyEvent::Status {
                session_id: session_id.to_owned(),
                status,
                exit_code: None,
            });
        }
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("PTY_SIZE_INVALID: terminal dimensions must be non-zero".into());
        }
        let runtime = self.live_runtime(session_id)?;
        let master = runtime.master.lock().map_err(lock_error)?;
        master
            .as_ref()
            .ok_or_else(|| NOT_FOUND.to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "PTY_RESIZE_FAILED: could not resize terminal".to_string())
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let runtime = self.runtime(session_id)?;
        if runtime.live.load(Ordering::Acquire) {
            stop_with_timeout(&runtime, GRACEFUL_STOP_TIMEOUT)
        } else {
            wait_for_event_completion(&runtime, Duration::from_secs(2))
        }
    }

    /// Re-emit what a live session has printed lately, for a webview that lost
    /// its xterm buffer to a page reload. Unknown or finished sessions replay
    /// nothing — there is no terminal left to repopulate.
    pub fn replay_output(&self, session_id: &str) -> Result<(), String> {
        let Ok(runtime) = self.live_runtime(session_id) else {
            return Ok(());
        };
        let recent = runtime.recent.lock().map_err(lock_error)?;
        if recent.is_empty() {
            return Ok(());
        }
        (runtime.callback)(PtyEvent::Output {
            session_id: session_id.to_owned(),
            data: String::from_utf8_lossy(&recent).into_owned(),
        });
        Ok(())
    }

    pub fn is_live(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).cloned())
            .is_some_and(|handle| handle.runtime.live.load(Ordering::Acquire))
    }

    fn runtime(&self, session_id: &str) -> Result<Arc<SessionRuntime>, String> {
        self.sessions
            .lock()
            .map_err(lock_error)?
            .get(session_id)
            .map(|handle| Arc::clone(&handle.runtime))
            .ok_or_else(|| NOT_FOUND.to_string())
    }

    fn live_runtime(&self, session_id: &str) -> Result<Arc<SessionRuntime>, String> {
        let runtime = self.runtime(session_id)?;
        if !runtime.live.load(Ordering::Acquire) {
            return Err(NOT_FOUND.into());
        }
        Ok(runtime)
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        let session_ids = self
            .sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for session_id in session_ids {
            let _ = self.stop(&session_id);
        }
    }
}

fn child_search_path(spec: &SpawnSpec, settings: &Settings) -> Option<OsString> {
    let configured = settings
        .env_vars
        .iter()
        .rev()
        .find(|env| is_path_key(&env.key))
        .map(|env| OsString::from(&env.value))
        .or_else(|| std::env::var_os("PATH"));
    let executable_directory = spec
        .launcher_directory
        .as_deref()
        .or_else(|| Path::new(&spec.program).parent())?;
    let mut directories = configured
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !directories
        .iter()
        .any(|directory| directory == executable_directory)
    {
        // Script-based CLIs commonly use a sibling runtime. Keep the resolved
        // launcher directory on PATH even when Windows dispatches a `.cmd` shim
        // through `cmd.exe`, whose directory is unrelated to that runtime.
        directories.insert(0, executable_directory.to_path_buf());
    }
    std::env::join_paths(directories).ok()
}

fn child_terminal_type(settings: &Settings) -> OsString {
    settings
        .env_vars
        .iter()
        .rev()
        .find(|env| is_term_key(&env.key))
        .map(|env| OsString::from(&env.value))
        .or_else(|| std::env::var_os("TERM"))
        .filter(|value| {
            let value = value.to_string_lossy();
            !value.trim().is_empty() && value != "dumb"
        })
        .unwrap_or_else(|| OsString::from("xterm-256color"))
}

#[cfg(windows)]
fn is_path_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("PATH")
}

#[cfg(not(windows))]
fn is_path_key(key: &str) -> bool {
    key == "PATH"
}

#[cfg(windows)]
fn is_term_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("TERM")
}

#[cfg(not(windows))]
fn is_term_key(key: &str) -> bool {
    key == "TERM"
}

enum ReaderMessage {
    Data(Vec<u8>),
    ReaderClosed,
    Exited(i32),
}

#[cfg(unix)]
fn make_reader(master: &(dyn MasterPty + Send)) -> Result<PtyReader, String> {
    let raw_fd = master
        .as_raw_fd()
        .ok_or_else(|| "PTY_OPEN_FAILED: terminal has no readable descriptor".to_string())?;
    let duplicated = unsafe { libc::fcntl(raw_fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        return Err("PTY_OPEN_FAILED: could not duplicate terminal reader".into());
    }
    // SAFETY: F_DUPFD_CLOEXEC returned a new owned descriptor that cannot leak
    // into spawned CLIs. File becomes its sole owner and closes it on reader exit.
    let reader = unsafe { std::fs::File::from_raw_fd(duplicated) };
    Ok(reader)
}

#[cfg(windows)]
fn make_reader(master: &(dyn MasterPty + Send)) -> Result<PtyReader, String> {
    master
        .try_clone_reader()
        .map_err(|_| "PTY_OPEN_FAILED: could not create terminal reader".to_string())
}

fn spawn_reader(
    mut reader: PtyReader,
    runtime: Arc<SessionRuntime>,
    sender: mpsc::Sender<ReaderMessage>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while !runtime.reader_cancel.load(Ordering::Acquire) {
            match read_with_cancellation(&mut reader, &runtime.reader_cancel, &mut buffer) {
                Ok(None) | Ok(Some(0)) => break,
                Ok(Some(read)) => {
                    if sender
                        .send(ReaderMessage::Data(buffer[..read].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        // Close the FD before publishing completion; respawn gating relies on
        // this release/acquire edge to prove the old reader owns no descriptor.
        drop(reader);
        runtime.reader_complete.store(true, Ordering::Release);
        let _ = sender.send(ReaderMessage::ReaderClosed);
    });
}

#[cfg(unix)]
fn read_with_cancellation(
    reader: &mut PtyReader,
    cancel: &AtomicBool,
    buffer: &mut [u8],
) -> std::io::Result<Option<usize>> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        let mut descriptor = libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        // SAFETY: poll only borrows this valid File descriptor for the call;
        // the reader thread remains its sole owner throughout the poll/read loop.
        let ready = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                READER_POLL_INTERVAL.as_millis() as libc::c_int,
            )
        };
        if ready > 0 {
            return reader.read(buffer).map(Some);
        }
        if ready == 0 {
            continue;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(windows)]
fn read_with_cancellation(
    reader: &mut PtyReader,
    cancel: &AtomicBool,
    buffer: &mut [u8],
) -> std::io::Result<Option<usize>> {
    if cancel.load(Ordering::Acquire) {
        Ok(None)
    } else {
        reader.read(buffer).map(Some)
    }
}

fn spawn_dispatcher(
    session_id: String,
    runtime: Arc<SessionRuntime>,
    receiver: mpsc::Receiver<ReaderMessage>,
) {
    thread::spawn(move || {
        let mut batch = Vec::new();
        let mut batch_deadline = None;
        let mut reader_closed = false;
        let mut exit_code = None;
        let mut exit_deadline = None;

        loop {
            let now = Instant::now();
            let timeout = [batch_deadline, exit_deadline]
                .into_iter()
                .flatten()
                .map(|deadline: Instant| deadline.saturating_duration_since(now))
                .min()
                .unwrap_or(STATUS_TICK_INTERVAL)
                .min(STATUS_TICK_INTERVAL);
            match receiver.recv_timeout(timeout) {
                Ok(ReaderMessage::Data(chunk)) => {
                    if batch.is_empty() {
                        batch_deadline = Some(Instant::now() + OUTPUT_BATCH_MAX_LATENCY);
                    }
                    batch.extend_from_slice(&chunk);
                }
                Ok(ReaderMessage::ReaderClosed) => reader_closed = true,
                Ok(ReaderMessage::Exited(code)) => {
                    exit_code = Some(code);
                    exit_deadline.get_or_insert_with(|| post_exit_drain_deadline(Instant::now()));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if batch.is_empty() {
                        emit_tick(&session_id, &runtime);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => reader_closed = true,
            }

            let exit_drain_expired =
                exit_deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if exit_drain_expired && !reader_closed {
                runtime.reader_cancel.store(true, Ordering::Release);
                exit_deadline = None;
            }
            if batch_deadline.is_some_and(|deadline| Instant::now() >= deadline)
                || ((reader_closed || exit_drain_expired) && exit_code.is_some())
            {
                if !batch.is_empty() {
                    emit_output(&session_id, &runtime, &batch);
                    batch.clear();
                }
                batch_deadline = None;
            }

            // ReaderClosed is ordered after every Data message from the reader,
            // so stopped cannot overtake bytes already produced by the PTY.
            if reader_closed {
                if let Some(code) = exit_code {
                    emit_stopped(&session_id, &runtime, code);
                    break;
                }
            }
        }
    });
}

fn emit_tick(session_id: &str, runtime: &SessionRuntime) {
    let transition = runtime
        .detector
        .lock()
        .ok()
        .and_then(|mut detector| detector.on_tick());
    if let Some(status) = transition {
        (runtime.callback)(PtyEvent::Status {
            session_id: session_id.to_owned(),
            status,
            exit_code: None,
        });
    }
}

fn spawn_waiter(
    session_id: String,
    runtime: Arc<SessionRuntime>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    sender: mpsc::Sender<ReaderMessage>,
) {
    thread::spawn(move || {
        let exit_code = child
            .wait()
            .map(|status| status.exit_code().min(i32::MAX as u32) as i32)
            .unwrap_or(1);
        runtime.live.store(false, Ordering::Release);
        #[cfg(unix)]
        if let Some(process_id) = runtime.process_id {
            // The direct child may exit while descendants still own the slave PTY.
            let _ = kill_remaining_process_group(process_id);
        }
        if let Ok(mut writer) = runtime.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = runtime.master.lock() {
            master.take();
        }
        if sender.send(ReaderMessage::Exited(exit_code)).is_err() {
            emit_stopped(&session_id, &runtime, exit_code);
        }
    });
}

/// Cap the retained buffer, dropping whole lines from the front so a replay
/// never begins inside an escape sequence or a multi-byte character.
fn trim_recent(recent: &mut Vec<u8>) {
    if recent.len() <= RECENT_OUTPUT_TRIM_AT {
        return;
    }
    let overflow = recent.len() - RECENT_OUTPUT_MAX_BYTES;
    // Full-screen redraws can run past the cap without a newline. Cutting mid
    // line then costs a few garbled leading characters; dropping the whole
    // buffer would cost the user the entire session.
    let cut = recent[overflow..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(overflow, |offset| overflow + offset + 1);
    recent.drain(..cut);
}

fn post_exit_drain_deadline(now: Instant) -> Instant {
    now + POST_EXIT_DRAIN_TIMEOUT
}

fn emit_output(session_id: &str, runtime: &SessionRuntime, bytes: &[u8]) {
    let data = String::from_utf8_lossy(bytes).into_owned();
    // Record and emit under one lock so `replay_output` sees a consistent
    // snapshot: concurrent output is either already in it or emitted after it.
    match runtime.recent.lock() {
        Ok(mut recent) => {
            recent.extend_from_slice(bytes);
            trim_recent(&mut recent);
            (runtime.callback)(PtyEvent::Output {
                session_id: session_id.to_owned(),
                data,
            });
        }
        // A poisoned buffer must not cost the user their live output.
        Err(_) => (runtime.callback)(PtyEvent::Output {
            session_id: session_id.to_owned(),
            data,
        }),
    }
    let transition = runtime
        .detector
        .lock()
        .ok()
        .and_then(|mut detector| detector.on_output(bytes));
    if let Some(status) = transition {
        (runtime.callback)(PtyEvent::Status {
            session_id: session_id.to_owned(),
            status,
            exit_code: None,
        });
    }
}

fn emit_stopped(session_id: &str, runtime: &SessionRuntime, exit_code: i32) {
    if runtime.stopped_emitted.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Ok(mut detector) = runtime.detector.lock() {
        detector.on_exit();
    }
    (runtime.callback)(PtyEvent::Status {
        session_id: session_id.to_owned(),
        status: Status::Stopped,
        exit_code: Some(exit_code),
    });
    // A replacement runtime may publish Running only after this callback returns.
    runtime.events_complete.store(true, Ordering::Release);
}

fn stop_with_timeout(runtime: &SessionRuntime, timeout: Duration) -> Result<(), String> {
    request_graceful_stop(runtime)?;
    let deadline = Instant::now() + timeout;
    while runtime.live.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }

    if runtime.live.load(Ordering::Acquire) {
        request_forced_stop(runtime)?;
        let forced_deadline = Instant::now() + Duration::from_secs(2);
        while runtime.live.load(Ordering::Acquire) && Instant::now() < forced_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if runtime.live.load(Ordering::Acquire) {
            return Err("PTY_STOP_FAILED: session process did not terminate".into());
        }
    }
    wait_for_event_completion(runtime, Duration::from_secs(2))
}

fn wait_for_event_completion(runtime: &SessionRuntime, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while !runtime.events_complete.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    if runtime.events_complete.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err("PTY_STOP_FAILED: stopped event did not complete".into())
    }
}

#[cfg(unix)]
fn request_graceful_stop(runtime: &SessionRuntime) -> Result<(), String> {
    let Some(process_id) = runtime.process_id else {
        return runtime
            .killer
            .lock()
            .map_err(lock_error)?
            .kill()
            .map_err(|_| "PTY_STOP_FAILED: could not terminate session process".to_string());
    };
    let pid = i32::try_from(process_id)
        .map_err(|_| "PTY_STOP_FAILED: session process id is invalid".to_string())?;
    // portable-pty makes the child a session leader, so its PID is also the process-group ID.
    let group_result = unsafe { libc::kill(-pid, libc::SIGTERM) };
    if group_result == 0 {
        return Ok(());
    }
    let process_result = unsafe { libc::kill(pid, libc::SIGTERM) };
    if process_result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err("PTY_STOP_FAILED: could not signal session process".into())
    }
}

#[cfg(unix)]
fn request_forced_stop(runtime: &SessionRuntime) -> Result<(), String> {
    signal_process_group_or_process(runtime, libc::SIGKILL)
}

#[cfg(unix)]
fn signal_process_group_or_process(runtime: &SessionRuntime, signal: i32) -> Result<(), String> {
    let process_id = runtime
        .process_id
        .ok_or_else(|| "PTY_STOP_FAILED: session process id is unavailable".to_string())?;
    let pid = i32::try_from(process_id)
        .map_err(|_| "PTY_STOP_FAILED: session process id is invalid".to_string())?;
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(());
    }
    // The process may have no surviving group leader; target its PID before
    // treating ESRCH as an already-completed stop.
    if unsafe { libc::kill(pid, signal) } == 0 {
        return Ok(());
    }
    if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err("PTY_STOP_FAILED: could not signal session process".into())
    }
}

#[cfg(unix)]
fn kill_remaining_process_group(process_id: u32) -> Result<(), String> {
    let pid = i32::try_from(process_id)
        .map_err(|_| "PTY_STOP_FAILED: session process id is invalid".to_string())?;
    if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
        return Ok(());
    }
    if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err("PTY_STOP_FAILED: could not terminate remaining process group".into())
    }
}

#[cfg(windows)]
fn request_graceful_stop(runtime: &SessionRuntime) -> Result<(), String> {
    // Closing/killing the ConPTY child is portable-pty's supported Windows shutdown path.
    runtime
        .killer
        .lock()
        .map_err(lock_error)?
        .kill()
        .map_err(|_| "PTY_STOP_FAILED: could not terminate session process".to_string())
}

#[cfg(windows)]
fn request_forced_stop(runtime: &SessionRuntime) -> Result<(), String> {
    request_graceful_stop(runtime)
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "PTY_STATE_FAILED: terminal state is unavailable".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::SpawnSpec;
    use crate::models::{EnvVar, Settings, Status};
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    fn manager_with_events() -> (PtyManager, Receiver<PtyEvent>) {
        let (sender, receiver) = mpsc::channel();
        let manager = PtyManager::with_callback(move |event| {
            let _ = sender.send(event);
        });
        (manager, receiver)
    }

    fn wait_for_event(
        receiver: &Receiver<PtyEvent>,
        timeout: Duration,
        predicate: impl Fn(&PtyEvent) -> bool,
    ) -> PtyEvent {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = receiver
                .recv_timeout(remaining)
                .expect("timed out waiting for PTY event");
            if predicate(&event) {
                return event;
            }
        }
    }

    #[test]
    fn unknown_session_operations_return_stable_errors() {
        let manager = PtyManager::new();

        assert_eq!(
            manager.write("missing", b"input"),
            Err("PTY_NOT_FOUND: no live PTY for session".into())
        );
        assert_eq!(
            manager.resize("missing", 80, 24),
            Err("PTY_NOT_FOUND: no live PTY for session".into())
        );
        assert_eq!(
            manager.stop("missing"),
            Err("PTY_NOT_FOUND: no live PTY for session".into())
        );
        assert!(!manager.is_live("missing"));
    }

    #[test]
    fn recent_output_is_capped_without_ever_starting_mid_line() {
        let mut recent = Vec::new();
        while recent.len() <= RECENT_OUTPUT_TRIM_AT {
            recent.extend_from_slice(b"0123456789abcdef\n");
        }

        trim_recent(&mut recent);

        assert!(recent.len() <= RECENT_OUTPUT_MAX_BYTES);
        assert!(recent.starts_with(b"0123456789abcdef\n"));
    }

    #[test]
    fn recent_output_under_the_trim_threshold_is_kept_whole() {
        let mut recent = b"one\ntwo\n".to_vec();

        trim_recent(&mut recent);

        assert_eq!(recent, b"one\ntwo\n");
    }

    #[test]
    fn replaying_an_unknown_session_is_a_no_op() {
        let (manager, receiver) = manager_with_events();

        assert_eq!(manager.replay_output("missing"), Ok(()));
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replay_output_resends_what_a_live_session_already_printed() {
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new(
            "/bin/sh",
            ["-c", "printf 'restored-line\\n'; sleep 30"],
            "/",
        );

        manager
            .spawn("replay", spec, 80, 24, &Settings::default())
            .unwrap();
        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("restored-line")),
        );

        // The webview reloaded: its buffer is gone but the PTY is still live.
        manager.replay_output("replay").unwrap();

        let event = wait_for_event(&receiver, Duration::from_secs(3), |event| {
            matches!(event, PtyEvent::Output { .. })
        });
        let PtyEvent::Output { session_id, data } = event else {
            unreachable!()
        };
        assert_eq!(session_id, "replay");
        assert!(data.contains("restored-line"));

        manager.stop("replay").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn spawn_applies_cwd_and_environment_override_and_emits_output() {
        let root = tempdir().unwrap();
        let (manager, receiver) = manager_with_events();
        let mut settings = Settings::default();
        settings.env_vars = vec![EnvVar {
            key: "ANCHOR_SYNTHETIC_ENV".into(),
            value: "synthetic-value".into(),
        }];
        let spec = SpawnSpec::new(
            "/bin/sh",
            [
                "-c",
                "printf 'cwd=%s env=%s' \"$PWD\" \"$ANCHOR_SYNTHETIC_ENV\"",
            ],
            root.path(),
        );

        manager.spawn("cwd-env", spec, 80, 24, &settings).unwrap();

        let event = wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("synthetic-value")),
        );
        let PtyEvent::Output { session_id, data } = event else {
            unreachable!()
        };
        assert_eq!(session_id, "cwd-env");
        assert!(data.contains(&format!(
            "cwd={}",
            root.path().canonicalize().unwrap().display()
        )));
        assert!(data.contains("env=synthetic-value"));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_replaces_dumb_term_with_interactive_terminal_type() {
        let (manager, receiver) = manager_with_events();
        let mut settings = Settings::default();
        settings.env_vars = vec![EnvVar {
            key: "TERM".into(),
            value: "dumb".into(),
        }];
        let spec = SpawnSpec::new("/bin/sh", ["-c", "printf 'term=%s' \"$TERM\""], "/");

        manager
            .spawn("interactive-term", spec, 80, 24, &settings)
            .unwrap();

        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("term=xterm-256color")),
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_path_includes_resolved_cli_directory_for_sibling_interpreters() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let bin = root.path().join("managed-runtime/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let interpreter = bin.join("synthetic-node");
        std::fs::write(
            &interpreter,
            b"#!/bin/sh\nprintf SIBLING_INTERPRETER_FOUND\n",
        )
        .unwrap();
        let launcher = bin.join("synthetic-codex");
        std::fs::write(&launcher, b"#!/usr/bin/env synthetic-node\n").unwrap();
        for executable in [&interpreter, &launcher] {
            let mut permissions = std::fs::metadata(executable).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(executable, permissions).unwrap();
        }
        let mut settings = Settings::default();
        settings.env_vars = vec![EnvVar {
            key: "PATH".into(),
            value: "/usr/bin:/bin".into(),
        }];
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new(launcher.to_string_lossy(), [] as [&str; 0], root.path());

        manager
            .spawn("sibling-interpreter", spec, 80, 24, &settings)
            .unwrap();

        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("SIBLING_INTERPRETER_FOUND")),
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_echoes_through_pty_and_resize_updates_terminal_dimensions() {
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new(
            "/bin/sh",
            [
                "-c",
                "IFS= read -r line; printf 'echo=%s\\n' \"$line\"; sleep 0.1; stty size",
            ],
            "/",
        );
        manager
            .spawn("interactive", spec, 80, 24, &Settings::default())
            .unwrap();

        manager.resize("interactive", 100, 40).unwrap();
        manager.write("interactive", b"hello-anchor\n").unwrap();

        let echoed = wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("echo=hello-anchor")),
        );
        assert!(matches!(echoed, PtyEvent::Output { .. }));
        let resized = wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("40 100")),
        );
        assert!(matches!(resized, PtyEvent::Output { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn unexpected_exit_emits_exit_code_once_and_marks_session_dead() {
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new("/bin/sh", ["-c", "exit 23"], "/");
        manager
            .spawn("exit-code", spec, 80, 24, &Settings::default())
            .unwrap();

        let stopped = wait_for_event(&receiver, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            )
        });
        assert_eq!(
            stopped,
            PtyEvent::Status {
                session_id: "exit-code".into(),
                status: Status::Stopped,
                exit_code: Some(23),
            }
        );
        assert!(!manager.is_live("exit-code"));
        assert!(receiver
            .recv_timeout(Duration::from_millis(100))
            .ok()
            .is_none_or(|event| !matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            )));
    }

    #[cfg(unix)]
    #[test]
    fn stop_uses_graceful_sigterm_path_before_forced_kill() {
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new(
            "/bin/sh",
            [
                "-c",
                "trap 'printf TERM_CAUGHT; exit 0' TERM; printf READY; while :; do sleep 1; done",
            ],
            "/",
        );
        manager
            .spawn("term", spec, 80, 24, &Settings::default())
            .unwrap();
        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("READY")),
        );

        manager.stop("term").unwrap();

        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("TERM_CAUGHT")),
        );
        let stopped = wait_for_event(&receiver, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            )
        });
        assert!(matches!(
            stopped,
            PtyEvent::Status {
                exit_code: Some(0),
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn callbacks_receive_lossy_output_and_status_transitions() {
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new(
            "/bin/sh",
            ["-c", "printf '\\377done\\a'; sleep 0.05; exit 0"],
            "/",
        );
        manager
            .spawn("events", spec, 80, 24, &Settings::default())
            .unwrap();

        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains('\u{fffd}') && data.contains("done")),
        );
        wait_for_event(&receiver, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Waiting,
                    exit_code: None,
                    ..
                }
            )
        });
        wait_for_event(&receiver, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    exit_code: Some(0),
                    ..
                }
            )
        });
    }

    #[cfg(unix)]
    #[test]
    fn dropping_manager_stops_live_children() {
        let root = tempdir().unwrap();
        let marker = root.path().join("stopped.marker");
        {
            let (manager, receiver) = manager_with_events();
            let spec = SpawnSpec::new(
                "/bin/sh",
                [
                    "-c",
                    "trap 'printf stopped > \"$1\"; exit 0' TERM; printf READY; while :; do sleep 1; done",
                    "anchor-test",
                    marker.to_str().unwrap(),
                ],
                "/",
            );
            manager
                .spawn("drop", spec, 80, 24, &Settings::default())
                .unwrap();
            wait_for_event(
                &receiver,
                Duration::from_secs(3),
                |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("READY")),
            );
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "stopped");
    }

    #[cfg(unix)]
    #[test]
    fn graceful_timeout_sigkills_term_and_hup_ignoring_process_group() {
        let (manager, receiver) = manager_with_events();
        let spec = SpawnSpec::new(
            "/bin/sh",
            [
                "-c",
                "trap '' TERM HUP; printf READY; while :; do sleep 1; done",
            ],
            "/",
        );
        manager
            .spawn("force-kill", spec, 80, 24, &Settings::default())
            .unwrap();
        wait_for_event(
            &receiver,
            Duration::from_secs(3),
            |event| matches!(event, PtyEvent::Output { data, .. } if data.contains("READY")),
        );

        let runtime = manager.runtime("force-kill").unwrap();
        stop_with_timeout(&runtime, Duration::from_millis(50)).unwrap();

        wait_for_event(&receiver, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            )
        });
        assert!(!manager.is_live("force-kill"));
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_duplicate_spawns_reserve_session_id_atomically() {
        use std::sync::{Arc, Barrier};

        let manager = Arc::new(PtyManager::new());
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let manager = Arc::clone(&manager);
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                manager.spawn(
                    "duplicate",
                    SpawnSpec::new("/bin/sh", ["-c", "sleep 10"], "/"),
                    80,
                    24,
                    &Settings::default(),
                )
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    matches!(result, Err(error) if error == "PTY_ALREADY_LIVE: session already has a live PTY")
                })
                .count(),
            1
        );
        manager.stop("duplicate").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn respawn_waits_until_old_stopped_callback_is_fully_ordered() {
        use std::sync::{Arc, Mutex};

        let (events_tx, events_rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let manager = PtyManager::with_callback(move |event| {
            if matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            ) {
                let _ = entered_tx.send(());
                let _ = release_rx.lock().unwrap().recv();
            }
            let _ = events_tx.send(event);
        });
        manager
            .spawn(
                "generation",
                SpawnSpec::new("/bin/sh", ["-c", "printf old; exit 0"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();

        let blocked = manager.spawn(
            "generation",
            SpawnSpec::new("/bin/sh", ["-c", "sleep 10"], "/"),
            80,
            24,
            &Settings::default(),
        );
        assert_eq!(
            blocked,
            Err("PTY_ALREADY_LIVE: session already has a live PTY".into())
        );
        release_tx.send(()).unwrap();
        wait_for_event(&events_rx, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            )
        });

        manager
            .spawn(
                "generation",
                SpawnSpec::new("/bin/sh", ["-c", "printf new; sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        wait_for_event(&events_rx, Duration::from_secs(3), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Running,
                    ..
                }
            )
        });
        let next = events_rx.recv_timeout(Duration::from_millis(250)).unwrap();
        assert!(matches!(next, PtyEvent::Output { data, .. } if data.contains("new")));
        release_tx.send(()).unwrap();
        manager.stop("generation").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stopped_follows_reader_eof_and_all_large_trailing_output() {
        let (manager, receiver) = manager_with_events();
        manager
            .spawn(
                "trailing",
                SpawnSpec::new(
                    "/bin/sh",
                    [
                        "-c",
                        "head -c 262144 /dev/zero | tr '\\0' x; printf TRAILING_MARKER",
                    ],
                    "/",
                ),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();

        let mut output = String::new();
        loop {
            match receiver.recv_timeout(Duration::from_secs(5)).unwrap() {
                PtyEvent::Output { data, .. } => output.push_str(&data),
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                } => break,
                PtyEvent::Status { .. } => {}
            }
        }
        assert!(output.len() >= 262_144);
        assert!(output.ends_with("TRAILING_MARKER"));
    }

    #[cfg(unix)]
    #[test]
    fn descendant_holding_slave_cannot_block_stopped_or_same_id_respawn() {
        let root = tempdir().unwrap();
        let ready = root.path().join("descendant.ready");
        let (manager, receiver) = manager_with_events();
        // setsid keeps this synthetic descendant alive even when the shell and
        // its owned process group exit, forcing the bounded non-EOF drain path.
        manager
            .spawn(
                "held-slave",
                SpawnSpec::new(
                    "/bin/sh",
                    [
                        "-c",
                        "/usr/bin/python3 -c 'import os, pathlib, signal, sys, time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGHUP, signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(5)' \"$1\" & while [ ! -f \"$1\" ]; do sleep 0.01; done; printf parent-exit; exit 0",
                        "anchor-test",
                        ready.to_str().unwrap(),
                    ],
                    "/",
                ),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        let old_runtime = manager.runtime("held-slave").unwrap();

        wait_for_event(&receiver, Duration::from_secs(1), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Stopped,
                    ..
                }
            )
        });
        let pid_deadline = Instant::now() + Duration::from_secs(1);
        let descendant_pid = loop {
            if let Some(pid) = std::fs::read_to_string(&ready)
                .ok()
                .and_then(|contents| contents.trim().parse::<i32>().ok())
                .filter(|pid| *pid > 0)
            {
                break pid;
            }
            assert!(
                Instant::now() < pid_deadline,
                "descendant did not publish a parseable PID before the deadline"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(unsafe { libc::kill(descendant_pid, 0) }, 0);
        assert!(old_runtime.reader_complete.load(Ordering::Acquire));
        manager
            .spawn(
                "held-slave",
                SpawnSpec::new("/bin/sh", ["-c", "printf replacement; sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        wait_for_event(&receiver, Duration::from_secs(2), |event| {
            matches!(
                event,
                PtyEvent::Status {
                    status: Status::Running,
                    ..
                }
            )
        });
        let replacement = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            matches!(replacement, PtyEvent::Output { data, .. } if data.contains("replacement"))
        );
        manager.stop("held-slave").unwrap();
        unsafe {
            libc::kill(descendant_pid, libc::SIGKILL);
        }
    }

    #[test]
    fn post_exit_drain_deadline_is_bounded_beyond_live_batch_latency() {
        let now = Instant::now();

        assert_eq!(
            post_exit_drain_deadline(now),
            now + Duration::from_millis(250)
        );
        assert!(Duration::from_millis(250) > OUTPUT_BATCH_MAX_LATENCY);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_closes_polled_reader_while_writer_remains_open() {
        let manager = PtyManager::new();
        manager
            .spawn(
                "reader-cancel",
                SpawnSpec::new("/bin/sh", ["-c", "sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        let runtime = manager.runtime("reader-cancel").unwrap();
        let mut pipe_fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(pipe_fds.as_mut_ptr()) }, 0);
        // SAFETY: pipe created both descriptors; this File exclusively owns
        // the read end while the test retains the write end to prevent EOF.
        let reader = unsafe { std::fs::File::from_raw_fd(pipe_fds[0]) };
        let (sender, receiver) = mpsc::channel();
        spawn_reader(reader, Arc::clone(&runtime), sender);
        std::thread::sleep(Duration::from_millis(20));
        assert!(!runtime.reader_complete.load(Ordering::Acquire));

        runtime.reader_cancel.store(true, Ordering::Release);

        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(100)).unwrap(),
            ReaderMessage::ReaderClosed
        ));
        assert!(runtime.reader_complete.load(Ordering::Acquire));
        unsafe {
            libc::close(pipe_fds[1]);
        }
        manager.stop("reader-cancel").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reader_setup_preserves_master_blocking_mode() {
        let manager = PtyManager::new();
        manager
            .spawn(
                "blocking-master",
                SpawnSpec::new("/bin/sh", ["-c", "sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        let runtime = manager.runtime("blocking-master").unwrap();
        let master = runtime.master.lock().unwrap();
        let raw_fd = master.as_ref().unwrap().as_raw_fd().unwrap();
        let flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFL) };
        let duplicate = make_reader(master.as_ref().unwrap().as_ref()).unwrap();
        let descriptor_flags = unsafe { libc::fcntl(duplicate.as_raw_fd(), libc::F_GETFD) };

        assert!(flags >= 0);
        assert_eq!(flags & libc::O_NONBLOCK, 0);
        assert!(descriptor_flags >= 0);
        assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
        drop(duplicate);
        drop(master);
        manager.stop("blocking-master").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_waits_for_stopped_callback_before_same_id_respawn() {
        use std::sync::atomic::AtomicBool;

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let block_once = Arc::new(AtomicBool::new(true));
        let manager = PtyManager::with_callback({
            let block_once = Arc::clone(&block_once);
            move |event| {
                if matches!(
                    event,
                    PtyEvent::Status {
                        status: Status::Stopped,
                        ..
                    }
                ) && block_once.swap(false, Ordering::AcqRel)
                {
                    let _ = entered_tx.send(());
                    let _ = release_rx.lock().unwrap().recv();
                }
            }
        });
        manager
            .spawn(
                "stop-respawn",
                SpawnSpec::new("/bin/sh", ["-c", "sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        let releaser = std::thread::spawn(move || {
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            release_tx.send(()).unwrap();
        });

        manager.stop("stop-respawn").unwrap();
        releaser.join().unwrap();

        manager
            .spawn(
                "stop-respawn",
                SpawnSpec::new("/bin/sh", ["-c", "sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        manager.stop("stop-respawn").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn write_callback_can_reenter_write_without_writer_lock_deadlock() {
        use std::sync::atomic::AtomicBool;

        let manager_slot = Arc::new(Mutex::new(None::<std::sync::Weak<PtyManager>>));
        let enabled = Arc::new(AtomicBool::new(false));
        let (result_tx, result_rx) = mpsc::channel();
        let manager = Arc::new(PtyManager::with_callback({
            let manager_slot = Arc::clone(&manager_slot);
            let enabled = Arc::clone(&enabled);
            move |event| {
                if matches!(
                    event,
                    PtyEvent::Status {
                        status: Status::Running,
                        ..
                    }
                ) && enabled.swap(false, Ordering::AcqRel)
                {
                    let manager = manager_slot
                        .lock()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .upgrade()
                        .unwrap();
                    let runtime = manager.runtime("reentrant-write").unwrap();
                    let writer_unlocked = runtime.writer.try_lock().is_ok();
                    let reentered =
                        writer_unlocked && manager.write("reentrant-write", b"second\n").is_ok();
                    let _ = result_tx.send(writer_unlocked && reentered);
                }
            }
        }));
        *manager_slot.lock().unwrap() = Some(Arc::downgrade(&manager));
        manager
            .spawn(
                "reentrant-write",
                SpawnSpec::new("/bin/sh", ["-c", "printf '\\a'; sleep 10"], "/"),
                80,
                24,
                &Settings::default(),
            )
            .unwrap();
        let runtime = manager.runtime("reentrant-write").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while runtime.detector.lock().unwrap().on_input().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        // Restore waiting deterministically without depending on callback observation.
        runtime.detector.lock().unwrap().on_output(b"\x07");
        enabled.store(true, Ordering::Release);

        manager.write("reentrant-write", b"first\n").unwrap();

        assert!(result_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        manager.stop("reentrant-write").unwrap();
    }
}
