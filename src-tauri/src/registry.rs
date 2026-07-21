//! Folder + session registry with crash-safe persistence.
//! SPEC.md §3. Phase 2 implements.
//!
//! Invariants:
//! - `registry.json` (under settings.backup_path, default ~/.anchor/sessions)
//!   is written on EVERY mutation, via temp-file + atomic rename.
//! - On load, every session's status is normalized to `stopped` (no process
//!   survives an app quit in v1).

#![allow(dead_code)] // Phase 1 skeleton

use crate::models::{AppState, Folder, Session};

/// On-disk shape of registry.json (versioned for future migration).
#[derive(serde::Serialize, serde::Deserialize)]
pub struct RegistryFile {
    pub version: u32,
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
}

#[derive(Default)]
pub struct Registry {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
}

impl Registry {
    pub fn load() -> Result<Self, String> {
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }

    /// Atomic write: serialize → write `<path>.tmp` → rename over `<path>`.
    pub fn save(&self) -> Result<(), String> {
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }

    pub fn snapshot(&self) -> AppState {
        AppState {
            folders: self.folders.clone(),
            sessions: self.sessions.clone(),
        }
    }
}
