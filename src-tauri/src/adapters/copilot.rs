//! GitHub Copilot CLI adapter (SPEC.md §5).
//! Launch: `copilot --resume <fresh-uuid>` — starting with an unknown UUID
//! creates a NEW session with that ID → PreAssigned.
//! Resume: `copilot --resume <uuid>`.

use super::{Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Tool};

pub struct CopilotAdapter;

impl Adapter for CopilotAdapter {
    fn tool(&self) -> Tool {
        Tool::Copilot
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
