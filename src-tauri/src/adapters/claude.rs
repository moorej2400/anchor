//! Claude Code adapter (SPEC.md §5).
//! Launch: `claude --session-id <uuid>` (Anchor generates the UUID → PreAssigned).
//! Resume: `claude --resume <uuid>`; picker fallback: `claude --resume` (no arg).

use super::{validate_extra_args, Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Settings, Tool};
use std::path::Path;

pub struct ClaudeAdapter;

impl Adapter for ClaudeAdapter {
    fn tool(&self) -> Tool {
        Tool::Claude
    }

    fn launch(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<(SpawnSpec, IdCapture), String> {
        validate_extra_args(Tool::Claude, &session.extra_args)?;
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let mut args = vec!["--session-id".into(), id.clone()];
        args.extend(session.extra_args.iter().cloned());
        Ok((
            SpawnSpec::new("claude", args, cwd),
            IdCapture::PreAssigned(id),
        ))
    }

    fn resume(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        let mut args = vec!["--resume".into()];
        args.extend(session.cli_session_id.iter().cloned());
        Ok(SpawnSpec::new("claude", args, cwd))
    }
}
