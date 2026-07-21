//! Claude Code adapter (SPEC.md §5).
//! Launch: `claude --session-id <uuid>` (Anchor generates the UUID → PreAssigned).
//! Resume: `claude --resume <uuid>`; picker fallback: `claude --resume` (no arg).

use super::{Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Tool};

pub struct ClaudeAdapter;

impl Adapter for ClaudeAdapter {
    fn tool(&self) -> Tool {
        Tool::Claude
    }

    fn launch(&self, session: &Session) -> Result<(SpawnSpec, IdCapture), String> {
        let _ = session;
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }

    fn resume(&self, session: &Session) -> Result<SpawnSpec, String> {
        let _ = session;
        Err("NOT_IMPLEMENTED: Phase 2".into())
    }
}
