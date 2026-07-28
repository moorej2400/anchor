//! Claude Code adapter (SPEC.md §5).
//! Launch: `claude --session-id <uuid>` (Anchor generates the UUID → PreAssigned).
//! Resume: use `claude --resume <uuid>` after Claude has saved its transcript;
//! otherwise recreate the same pre-assigned identity with `--session-id <uuid>`.

use super::{session_id_for_resume, validate_extra_args, Adapter, IdCapture, SpawnSpec};
use crate::models::{Session, Settings, Tool};
use std::fs;
use std::path::{Path, PathBuf};

pub struct ClaudeAdapter {
    projects_root: Option<PathBuf>,
}

impl Default for ClaudeAdapter {
    fn default() -> Self {
        Self {
            projects_root: dirs::home_dir().map(|home| home.join(".claude/projects")),
        }
    }
}

impl ClaudeAdapter {
    /// Creates an adapter with a supplied Claude projects directory for tests.
    pub fn with_projects_root(projects_root: impl AsRef<Path>) -> Self {
        Self {
            projects_root: Some(projects_root.as_ref().to_path_buf()),
        }
    }

    fn has_persisted_session(&self, session_id: &str) -> bool {
        let Some(projects_root) = self.projects_root.as_deref() else {
            return false;
        };
        let Ok(projects) = fs::read_dir(projects_root) else {
            return false;
        };

        for project in projects.filter_map(Result::ok) {
            if project.file_type().is_ok_and(|kind| kind.is_dir())
                && project.path().join(format!("{session_id}.jsonl")).is_file()
            {
                return true;
            }
        }
        false
    }
}

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
        let id = session_id_for_resume(session, Tool::Claude)?;
        // Claude accepts a generated `--session-id` before it writes a transcript,
        // while `--resume` rejects that same ID until its first persisted turn.
        let args = if self.has_persisted_session(id) {
            ["--resume", id]
        } else {
            ["--session-id", id]
        };
        Ok(SpawnSpec::new("claude", args, cwd))
    }
}
