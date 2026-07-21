//! Codex adapter (SPEC.md §5).
//! Launch: `codex` (no pre-assign flag → Discover).
//! Discovery: watch `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for a new
//! file (mtime ≥ launch) whose first-line JSON metadata `cwd` matches the
//! session's folder; extract the session UUID. Parsing failures = pending,
//! never a crash (store layout is version-fragile — fixture tests required).
//! Resume: `codex resume <uuid>`; picker fallback: `codex resume` (no args).

use super::{Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Tool};

pub struct CodexAdapter;

impl Adapter for CodexAdapter {
    fn tool(&self) -> Tool {
        Tool::Codex
    }

    fn launch(&self, session: &Session) -> Result<(SpawnSpec, IdCapture), String> {
        let _ = session;
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }

    fn resume(&self, session: &Session) -> Result<SpawnSpec, String> {
        let _ = session;
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }

    fn discover_session_id(&self, session: &Session) -> Result<Option<String>, String> {
        let _ = session;
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }
}
