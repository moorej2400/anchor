//! Terminal scrollback persistence (SPEC.md §3, §5 `terminal` row).
//! Files: `<backup_path>/scrollback/<session-uuid>.txt`.
//! Pruned per settings.retention_days. Phase 2 implements.

#![allow(dead_code)] // Phase 1 skeleton

pub fn append(session_id: &str, data: &[u8]) -> Result<(), String> {
    let _ = (session_id, data);
    Err("NOT_IMPLEMENTED: Phase 2".into())
}

pub fn read(session_id: &str) -> Result<String, String> {
    let _ = session_id;
    Err("NOT_IMPLEMENTED: Phase 2".into())
}

pub fn delete(session_id: &str) -> Result<(), String> {
    let _ = session_id;
    Err("NOT_IMPLEMENTED: Phase 2".into())
}

/// Remove scrollback files older than retention_days.
pub fn prune(retention_days: u32) -> Result<(), String> {
    let _ = retention_days;
    Err("NOT_IMPLEMENTED: Phase 2".into())
}
