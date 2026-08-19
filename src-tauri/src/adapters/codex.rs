//! Codex adapter (SPEC.md §5).
//! Launch: `codex [--profile <name>]` (no pre-assign flag → Discover).
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
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const PRE_LAUNCH_MTIME_TOLERANCE: Duration = Duration::from_secs(2);

pub struct CodexAdapter {
    sessions_roots: Vec<PathBuf>,
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::with_session_roots(codex_session_roots())
    }
}

impl CodexAdapter {
    pub fn with_sessions_root(path: impl AsRef<Path>) -> Self {
        Self::with_session_roots([path.as_ref().to_path_buf()])
    }

    fn with_session_roots(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut sessions_roots = Vec::new();
        for root in roots {
            if !sessions_roots.contains(&root) {
                sessions_roots.push(root);
            }
        }
        Self { sessions_roots }
    }

    pub fn discover_session_id_at(
        &self,
        cwd: &Path,
        launched_at: SystemTime,
        now: SystemTime,
    ) -> Result<Option<String>, String> {
        // Codex's store is explicitly version-fragile; unreadable directories
        // and malformed candidates remain pending instead of breaking the PTY.
        // A desktop launcher can inherit a stale CODEX_HOME while `codex` uses
        // the normal home directory. Check both roots so that mismatch cannot
        // leave a live session without its resume key.
        Ok(self
            .sessions_roots
            .iter()
            .filter_map(|root| newest_rollout(root, cwd, launched_at, now))
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, id)| id))
    }

    pub fn recover_session_id_at(
        &self,
        cwd: &Path,
        launched_at: SystemTime,
        ended_at: SystemTime,
    ) -> Result<Option<String>, String> {
        if let Some(id) = self.discover_session_id_at(cwd, launched_at, ended_at)? {
            return Ok(Some(id));
        }

        // Older Windows builds let cmd.exe replace an intended UNC cwd with
        // C:\Windows. A single rollout in the saved activity window is still
        // unambiguous; multiple candidates fail closed instead of guessing.
        let ids = self
            .sessions_roots
            .iter()
            .flat_map(|root| rollout_candidates(root, launched_at, ended_at))
            .filter_map(|(_, path)| parse_rollout(&path).map(|(id, _)| id))
            .collect::<HashSet<_>>();
        Ok((ids.len() == 1).then(|| ids.into_iter().next().unwrap()))
    }
}

/// Return profile names only. Profile TOML values can contain provider
/// credentials, so Anchor never opens or serializes profile file contents.
pub fn available_profiles() -> Vec<String> {
    codex_home().map_or_else(Vec::new, |root| available_profiles_at(&root))
}

pub(crate) fn available_profiles_at(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    let mut profiles = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_file())
                .and_then(|_| profile_name_from_path(&entry.path()))
        })
        .collect::<Vec<_>>();
    profiles.sort_unstable();
    profiles.dedup();
    profiles
}

pub(crate) fn validate_profile_name(profile: &str) -> Result<(), String> {
    if !is_valid_profile_name(profile) {
        return Err("CODEX_PROFILE_INVALID: profile name is not supported".into());
    }
    Ok(())
}

pub(crate) fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

fn codex_session_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = codex_home() {
        roots.push(home.join("sessions"));
    }
    if let Some(home) = dirs::home_dir() {
        let default_root = home.join(".codex/sessions");
        if !roots.contains(&default_root) {
            roots.push(default_root);
        }
    }
    roots
}

fn profile_name_from_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?.strip_suffix(".config.toml")?;
    is_valid_profile_name(name).then(|| name.to_owned())
}

fn is_valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
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
        if let Some(profile) = &session.codex_profile {
            validate_profile_name(profile)?;
        }
        let mut args = Vec::new();
        if let Some(profile) = &session.codex_profile {
            args.extend(["--profile".to_owned(), profile.clone()]);
        }
        args.extend(session.extra_args.clone());
        Ok((SpawnSpec::new("codex", args, cwd), IdCapture::Discover))
    }

    fn resume(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        let id = session_id_for_resume(session, Tool::Codex)?;
        if let Some(profile) = &session.codex_profile {
            validate_profile_name(profile)?;
        }
        let mut args = Vec::new();
        if let Some(profile) = &session.codex_profile {
            args.extend(["--profile".to_owned(), profile.clone()]);
        }
        args.extend(["resume".to_owned(), id.to_owned()]);
        Ok(SpawnSpec::new("codex", args, cwd))
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
    rollout_candidates(root, launched_at, now)
        .into_iter()
        .filter_map(|(modified, path)| parse_matching_rollout(&path, cwd).map(|id| (modified, id)))
        .max_by_key(|(modified, _)| *modified)
}

fn rollout_candidates(
    root: &Path,
    launched_at: SystemTime,
    now: SystemTime,
) -> Vec<(SystemTime, PathBuf)> {
    if !root.is_dir() {
        return Vec::new();
    }
    let cutoff = launched_at
        .checked_sub(PRE_LAUNCH_MTIME_TOLERANCE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let end = now.checked_add(PRE_LAUNCH_MTIME_TOLERANCE).unwrap_or(now);
    // Codex partitions by the machine's local date, while SystemTime is UTC;
    // adjacent UTC dates conservatively cover every timezone boundary.
    let mut date = utc_date(cutoff)
        .pred_opt()
        .unwrap_or_else(|| utc_date(cutoff));
    let current_end = utc_date(now.max(launched_at));
    let end_date = current_end.succ_opt().unwrap_or(current_end);
    let mut candidates = Vec::new();

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
                Ok(modified) if modified >= cutoff && modified <= end => modified,
                _ => continue,
            };
            candidates.push((modified, entry.path()));
        }
        let Some(next) = date.succ_opt() else {
            break;
        };
        date = next;
    }

    candidates
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

pub(crate) fn parse_matching_rollout(path: &Path, cwd: &Path) -> Option<String> {
    let (id, rollout_cwd) = parse_rollout(path)?;
    paths_match(&rollout_cwd, cwd).then_some(id)
}

fn parse_rollout(path: &Path) -> Option<(String, PathBuf)> {
    let file = fs::File::open(path).ok()?;
    let mut first_line = String::new();
    BufReader::new(file).read_line(&mut first_line).ok()?;
    let metadata: serde_json::Value = serde_json::from_str(&first_line).ok()?;
    if metadata.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = metadata.get("payload")?;
    let cwd = PathBuf::from(payload.get("cwd")?.as_str()?);
    let rollout_id = rollout_id_from_filename(path)?;
    let metadata_id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))?
        .as_str()?;
    let metadata_id = uuid::Uuid::parse_str(metadata_id)
        .ok()?
        .hyphenated()
        .to_string();
    if metadata_id != rollout_id {
        return None;
    }
    Some((rollout_id, cwd))
}

fn rollout_id_from_filename(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_str()?;
    let stem = filename.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    Some(uuid::Uuid::parse_str(id).ok()?.hyphenated().to_string())
}
