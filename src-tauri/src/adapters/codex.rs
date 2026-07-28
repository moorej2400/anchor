//! Codex adapter (SPEC.md §5).
//! Launch: `codex` (no pre-assign flag → Discover).
//! Discovery: watch `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for a new
//! file (mtime ≥ launch) whose first-line JSON metadata `cwd` matches the
//! session's folder; extract the session UUID. Parsing failures = pending,
//! never a crash (store layout is version-fragile — fixture tests required).
//! Resume: `codex resume <uuid>`; a missing persisted ID is an error.

use super::{
    paths_match, session_id_for_resume, validate_extra_args, Adapter, IdCapture, SpawnSpec,
};
use crate::models::{Session, Settings, Tool};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const PRE_LAUNCH_MTIME_TOLERANCE: Duration = Duration::from_secs(2);

pub struct CodexAdapter {
    sessions_root: Option<PathBuf>,
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self {
            sessions_root: dirs::home_dir().map(|home| home.join(".codex/sessions")),
        }
    }
}

impl CodexAdapter {
    pub fn with_sessions_root(path: impl AsRef<Path>) -> Self {
        Self {
            sessions_root: Some(path.as_ref().to_path_buf()),
        }
    }

    pub fn discover_session_id_at(
        &self,
        cwd: &Path,
        launched_at: SystemTime,
        now: SystemTime,
    ) -> Result<Option<String>, String> {
        let Some(root) = self.sessions_root.as_deref() else {
            return Ok(None);
        };

        // Codex's store is explicitly version-fragile; unreadable directories
        // and malformed candidates remain pending instead of breaking the PTY.
        Ok(newest_rollout(root, cwd, launched_at, now).map(|(_, id)| id))
    }
}

impl Adapter for CodexAdapter {
    fn tool(&self) -> Tool {
        Tool::Codex
    }

    fn launch(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<(SpawnSpec, IdCapture), String> {
        validate_extra_args(Tool::Codex, &session.extra_args)?;
        Ok((
            SpawnSpec::new("codex", session.extra_args.clone(), cwd),
            IdCapture::Discover,
        ))
    }

    fn resume(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        let id = session_id_for_resume(session, Tool::Codex)?;
        Ok(SpawnSpec::new("codex", ["resume", id], cwd))
    }

    fn discover_session_id(
        &self,
        cwd: &Path,
        launched_at: SystemTime,
    ) -> Result<Option<String>, String> {
        self.discover_session_id_at(cwd, launched_at, SystemTime::now())
    }
}

fn newest_rollout(
    root: &Path,
    cwd: &Path,
    launched_at: SystemTime,
    now: SystemTime,
) -> Option<(SystemTime, String)> {
    if !root.is_dir() {
        return None;
    }
    let cutoff = launched_at
        .checked_sub(PRE_LAUNCH_MTIME_TOLERANCE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    // Codex partitions by the machine's local date, while SystemTime is UTC;
    // adjacent UTC dates conservatively cover every timezone boundary.
    let mut date = utc_date(cutoff)
        .pred_opt()
        .unwrap_or_else(|| utc_date(cutoff));
    let current_end = utc_date(now.max(launched_at));
    let end_date = current_end.succ_opt().unwrap_or(current_end);
    let mut newest = None;

    while date <= end_date {
        let directory = root
            .join(format!("{:04}", date.year()))
            .join(format!("{:02}", date.month()))
            .join(format!("{:02}", date.day()));
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                let Some(next) = date.succ_opt() else {
                    break;
                };
                date = next;
                continue;
            }
        };
        for entry in entries.filter_map(Result::ok) {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_file() {
                continue;
            }
            if !is_rollout_jsonl(&entry.path()) {
                continue;
            }
            let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
                Ok(modified) if modified >= cutoff => modified,
                _ => continue,
            };
            let Some(id) = parse_matching_rollout(&entry.path(), cwd) else {
                continue;
            };
            if newest
                .as_ref()
                .is_none_or(|(newest_modified, _)| modified > *newest_modified)
            {
                newest = Some((modified, id));
            }
        }
        let Some(next) = date.succ_opt() else {
            break;
        };
        date = next;
    }

    newest
}

fn utc_date(time: SystemTime) -> NaiveDate {
    DateTime::<Utc>::from(time).date_naive()
}

fn is_rollout_jsonl(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-"))
}

fn parse_matching_rollout(path: &Path, cwd: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut first_line = String::new();
    BufReader::new(file).read_line(&mut first_line).ok()?;
    let metadata: serde_json::Value = serde_json::from_str(&first_line).ok()?;
    if metadata.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = metadata.get("payload")?;
    let id = payload.get("id")?.as_str()?;
    uuid::Uuid::parse_str(id).ok()?;
    if !paths_match(Path::new(payload.get("cwd")?.as_str()?), cwd) {
        return None;
    }
    let filename = path.file_name()?.to_str()?;
    if !filename.strip_suffix(".jsonl")?.ends_with(id) {
        return None;
    }
    Some(id.to_owned())
}
