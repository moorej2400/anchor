//! Settings load/save (SPEC.md §3, §7). Phase 2 implements.
//! settings.json lives in the app config/data dir; env-var VALUES are user
//! secrets — they stay local, are masked in the UI, and must never appear in
//! logs, error messages, or committed files (public repo).

#![allow(dead_code)] // Phase 1 skeleton

use crate::models::Settings;

pub fn load() -> Result<Settings, String> {
    Ok(Settings::default())
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let _ = settings;
    Err("NOT_IMPLEMENTED: Phase 2".into())
}
