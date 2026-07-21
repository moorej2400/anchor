//! opencode adapter (SPEC.md §5).
//! Launch: `opencode` run in the folder (→ Discover).
//! Discovery: read opencode's sqlite DB (platform data dir, e.g.
//! `~/.local/share/opencode/opencode.db`) READ-ONLY (immutable/read-only open
//! flags to avoid locking): newest session row with directory == folder path
//! and created ≥ launch time.
//! Resume: `opencode --session <id>` run in the folder.

use super::{Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Tool};

pub struct OpencodeAdapter;

impl Adapter for OpencodeAdapter {
    fn tool(&self) -> Tool {
        Tool::Opencode
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
