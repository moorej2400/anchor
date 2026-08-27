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

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

const PRE_LAUNCH_MTIME_TOLERANCE: Duration = Duration::from_secs(2);
const RECOVERY_SESSION_START_WINDOW: Duration = Duration::from_secs(60);
pub(crate) const ACTIVE_WRITER_CODE: &str = "CODEX_ACTIVE_WRITER";
pub(crate) const ACTIVE_WRITER_MESSAGE: &str = "This Codex conversation is already open in another Codex session. Close the other session and retry, or fork it to continue in parallel.";
#[cfg(windows)]
const WINDOWS_FILE_SHARE_READ: u32 = 1;

enum RecoveryMatch {
    Missing,
    Unique(String),
    Ambiguous,
}

struct RolloutMetadata {
    id: String,
    cwd: PathBuf,
    started_at: Option<SystemTime>,
}

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
        // A rollout's mtime advances for every appended turn, so startup
        // recovery must prefer the immutable session-start timestamp in its
        // first metadata record. Otherwise long sessions disappear from their
        // original launch window after Anchor restarts.
        match self.recovery_match_from_session_start(cwd, launched_at) {
            RecoveryMatch::Unique(id) => return Ok(Some(id)),
            RecoveryMatch::Ambiguous => return Ok(None),
            RecoveryMatch::Missing => {}
        }

        // Legacy rollouts did not record a start timestamp. Keep their mtime
        // recovery path, but require one exact-cwd ID or one total ID rather
        // than selecting a newer unrelated session from a broad activity span.
        Ok(select_recovery_match(
            self.sessions_roots
                .iter()
                .flat_map(|root| rollout_candidates(root, launched_at, ended_at))
                .filter_map(|(_, path)| parse_rollout(&path)),
            cwd,
        ))
    }

    fn recovery_match_from_session_start(
        &self,
        cwd: &Path,
        launched_at: SystemTime,
    ) -> RecoveryMatch {
        let cutoff = launched_at
            .checked_sub(PRE_LAUNCH_MTIME_TOLERANCE)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let end = launched_at
            .checked_add(RECOVERY_SESSION_START_WINDOW)
            .unwrap_or(launched_at);
        let rollouts = self
            .sessions_roots
            .iter()
            .flat_map(|root| rollout_paths(root, cutoff, end))
            .filter_map(|path| parse_rollout(&path))
            .filter(|rollout| {
                rollout
                    .started_at
                    .is_some_and(|started_at| started_at >= cutoff && started_at <= end)
            });
        recovery_match(rollouts, cwd)
    }

    fn rollout_paths_for_id(&self, session_id: &str) -> Vec<PathBuf> {
        let suffix = format!("{session_id}.jsonl");
        self.sessions_roots
            .iter()
            .flat_map(|root| {
                let mut directories = vec![root.clone()];
                for _ in 0..3 {
                    directories = directories
                        .into_iter()
                        .flat_map(|directory| {
                            fs::read_dir(directory)
                                .into_iter()
                                .flatten()
                                .filter_map(Result::ok)
                                .filter_map(|entry| {
                                    entry
                                        .file_type()
                                        .ok()
                                        .filter(|kind| kind.is_dir())
                                        .map(|_| entry.path())
                                })
                                .collect::<Vec<_>>()
                        })
                        .collect();
                }
                directories.into_iter().flat_map(|directory| {
                    fs::read_dir(directory)
                        .into_iter()
                        .flatten()
                        .filter_map(Result::ok)
                        .filter_map(|entry| {
                            let path = entry.path();
                            entry
                                .file_type()
                                .ok()
                                .filter(|kind| kind.is_file())
                                .and_then(|_| {
                                    path.file_name()
                                        .and_then(|name| name.to_str())
                                        .filter(|name| {
                                            name.starts_with("rollout-") && name.ends_with(&suffix)
                                        })
                                        .map(|_| path.clone())
                                })
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect()
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

    fn preflight_resume(&self, session: &Session) -> Result<(), String> {
        let id = session_id_for_resume(session, Tool::Codex)?;
        #[cfg(windows)]
        for path in self.rollout_paths_for_id(id) {
            // Codex keeps the active rollout open for the lifetime of its
            // writer. This probe permits other readers and requests no
            // mutation, but Windows returns sharing violation 32 when an
            // existing handle has write access.
            match fs::OpenOptions::new()
                .read(true)
                .share_mode(WINDOWS_FILE_SHARE_READ)
                .open(path)
            {
                Ok(_) => {}
                Err(error) if error.raw_os_error() == Some(32) => {
                    return Err(format!("{ACTIVE_WRITER_CODE}: {ACTIVE_WRITER_MESSAGE}"));
                }
                // Access and store-layout errors are not proof of contention.
                // Let Codex report its own specific resume error instead.
                Err(_) => {}
            }
        }
        #[cfg(not(windows))]
        let _ = id;
        Ok(())
    }

    fn fork(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<(SpawnSpec, IdCapture), String> {
        let id = session_id_for_resume(session, Tool::Codex)?;
        if let Some(profile) = &session.codex_profile {
            validate_profile_name(profile)?;
        }
        let mut args = Vec::new();
        if let Some(profile) = &session.codex_profile {
            args.extend(["--profile".to_owned(), profile.clone()]);
        }
        args.extend(["fork".to_owned(), id.to_owned()]);
        // Codex assigns the fork a fresh UUID. Reuse the normal bounded store
        // discovery so the new Anchor record never adopts a picked session.
        Ok((SpawnSpec::new("codex", args, cwd), IdCapture::Discover))
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
    let cutoff = launched_at
        .checked_sub(PRE_LAUNCH_MTIME_TOLERANCE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let end = now.checked_add(PRE_LAUNCH_MTIME_TOLERANCE).unwrap_or(now);
    rollout_paths(root, cutoff, end)
        .into_iter()
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            (modified >= cutoff && modified <= end).then_some((modified, path))
        })
        .collect()
}

fn rollout_paths(root: &Path, start: SystemTime, end: SystemTime) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    // Codex partitions by the machine's local date, while SystemTime is UTC;
    // adjacent UTC dates conservatively cover every timezone boundary.
    let mut date = utc_date(start)
        .pred_opt()
        .unwrap_or_else(|| utc_date(start));
    let current_end = utc_date(end.max(start));
    let end_date = current_end.succ_opt().unwrap_or(current_end);
    let mut paths = Vec::new();

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
            paths.push(entry.path());
        }
        let Some(next) = date.succ_opt() else {
            break;
        };
        date = next;
    }

    paths
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
    let rollout = parse_rollout(path)?;
    paths_match(&rollout.cwd, cwd).then_some(rollout.id)
}

fn parse_rollout(path: &Path) -> Option<RolloutMetadata> {
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
    let started_at = metadata
        .get("timestamp")
        .or_else(|| payload.get("timestamp"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc).into());
    Some(RolloutMetadata {
        id: rollout_id,
        cwd,
        started_at,
    })
}

fn recovery_match(
    rollouts: impl IntoIterator<Item = RolloutMetadata>,
    cwd: &Path,
) -> RecoveryMatch {
    let mut matching_ids = HashSet::new();
    for rollout in rollouts {
        if paths_match(&rollout.cwd, cwd) {
            matching_ids.insert(rollout.id);
        }
    }

    match matching_ids.len() {
        1 => RecoveryMatch::Unique(matching_ids.into_iter().next().unwrap()),
        2.. => RecoveryMatch::Ambiguous,
        _ => RecoveryMatch::Missing,
    }
}

fn select_recovery_match(
    rollouts: impl IntoIterator<Item = RolloutMetadata>,
    cwd: &Path,
) -> Option<String> {
    match recovery_match(rollouts, cwd) {
        RecoveryMatch::Unique(id) => Some(id),
        RecoveryMatch::Missing | RecoveryMatch::Ambiguous => None,
    }
}

fn rollout_id_from_filename(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_str()?;
    let stem = filename.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    Some(uuid::Uuid::parse_str(id).ok()?.hyphenated().to_string())
}
