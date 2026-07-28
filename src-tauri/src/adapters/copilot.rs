//! GitHub Copilot CLI adapter (SPEC.md §5).
//! Launch: `copilot --resume <fresh-uuid>` — starting with an unknown UUID
//! creates a NEW session with that ID → PreAssigned.
//! Resume: `copilot --resume <uuid>`.

use super::{session_id_for_resume, validate_extra_args, Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Settings, Tool};
use std::path::Path;

pub struct CopilotAdapter;

impl Adapter for CopilotAdapter {
    fn tool(&self) -> Tool {
        Tool::Copilot
    }

    fn launch(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<(SpawnSpec, IdCapture), String> {
        validate_extra_args(Tool::Copilot, &session.extra_args)?;
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let mut args = vec!["--resume".into(), id.clone()];
        args.extend(session.extra_args.iter().cloned());
        Ok((
            SpawnSpec::new("copilot", args, cwd),
            IdCapture::PreAssigned(id),
        ))
    }

    fn resume(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        let id = session_id_for_resume(session, Tool::Copilot)?;
        Ok(SpawnSpec::new("copilot", ["--resume", id], cwd))
    }
}
