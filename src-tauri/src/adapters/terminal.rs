//! Generic terminal adapter (SPEC.md §5).
//! Launch: the user's default shell (settings.shell) in the folder.
//! Persistence = scrollback file (scrollback.rs), not a session ID.
//! Resume: respawn shell; if settings.restore_scrollback, the frontend
//! prepends saved scrollback with a "── restored session · scrollback
//! recovered (N lines) ──" divider (see mock).

use super::{Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Tool};

pub struct TerminalAdapter;

impl Adapter for TerminalAdapter {
    fn tool(&self) -> Tool {
        Tool::Terminal
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
