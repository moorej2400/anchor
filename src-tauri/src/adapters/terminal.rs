//! Generic terminal adapter (SPEC.md §5).
//! Launch: the user's default shell (settings.shell) in the folder.
//! Persistence = scrollback file (scrollback.rs), not a session ID.
//! Resume: respawn shell; if settings.restore_scrollback, the frontend
//! prepends saved scrollback with a "── restored session · scrollback
//! recovered (N lines) ──" divider (see mock).

use super::{validate_extra_args, Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Settings, Tool};
use std::path::Path;

pub struct TerminalAdapter;

impl Adapter for TerminalAdapter {
    fn tool(&self) -> Tool {
        Tool::Terminal
    }

    fn launch(
        &self,
        session: &Session,
        cwd: &Path,
        settings: &Settings,
    ) -> Result<(SpawnSpec, IdCapture), String> {
        validate_extra_args(Tool::Terminal, &session.extra_args)?;
        Ok((
            SpawnSpec::new(&settings.shell, session.extra_args.clone(), cwd),
            IdCapture::None,
        ))
    }

    fn resume(
        &self,
        _session: &Session,
        cwd: &Path,
        settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        Ok(SpawnSpec::new(
            &settings.shell,
            std::iter::empty::<String>(),
            cwd,
        ))
    }
}
