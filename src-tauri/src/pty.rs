//! PTY management (spawn / read / write / resize / kill) via `portable-pty`.
//! SPEC.md §§2, 5, 6. Phase 2 implements.
//!
//! Responsibilities:
//! - One PTY per ON session, spawned with cwd = folder path, env = process env
//!   + settings.env_vars, size = current cols/rows.
//! - Reader thread per PTY: lossy-UTF-8 decode, batch `pty:output` events
//!   (≤ every 16 ms per session), feed `status.rs` detection.
//! - Graceful stop: SIGTERM → SIGKILL after 5 s (ConPTY close on Windows).
//! - Emit `session:status` with exit code on process exit.

#![allow(dead_code)] // Phase 1 skeleton

use std::collections::HashMap;

/// Handle to a live PTY session. Phase 2 fills in the real fields
/// (master, writer, child, reader-thread join handle).
pub struct PtyHandle {}

/// Registry of live PTYs keyed by Anchor session id.
/// Held in Tauri managed state behind a Mutex.
#[derive(Default)]
pub struct PtyManager {
    live: HashMap<String, PtyHandle>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }
}
