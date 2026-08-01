//! Folder + session registry with crash-safe, version-aware persistence.
//!
//! Invariants:
//! - `registry.json` (under settings.backup_path, default ~/.anchor/sessions)
//!   is written on EVERY mutation, via temp-file + atomic rename.
//! - A checksummed last-good file and rotating generations recover supported
//!   corrupt data without ever replacing a newer unsupported schema.
//! - On load, every session's status is normalized to `stopped` because no
//!   managed child process survives a full application exit.

#![allow(dead_code)] // Used by later Phase 2 orchestration tasks.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::adapters::codex::validate_profile_name;
use crate::durable_file::{atomic_write, atomic_write_with_directory_sync, sha256_hex};
use crate::models::{AppState, Folder, Session, Status, Tool};

const REGISTRY_VERSION: u32 = 2;
const OLDEST_SUPPORTED_REGISTRY_VERSION: u32 = 1;
const RECOVERY_FORMAT_VERSION: u32 = 1;
const MAX_GENERATIONS: usize = 10;

/// On-disk shape of registry.json (versioned for future migration).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegistryFile {
    pub version: u32,
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryRecovery {
    format_version: u32,
    created_at: String,
    sha256: String,
    registry: RegistryFile,
}

pub struct Registry {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
    backup_path: PathBuf,
}

impl Registry {
    pub fn load() -> Result<Self, String> {
        let settings = crate::settings::load()?;
        let backup_path = crate::settings::expand_tilde(&settings.backup_path)?;
        Self::load_from_backup_path(backup_path)
    }

    pub fn load_from_backup_path(backup_path: impl AsRef<Path>) -> Result<Self, String> {
        let backup_path = resolve_backup_path(backup_path.as_ref())?;
        let path = backup_path.join("registry.json");
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(file) = load_recovery_candidate(&backup_path)? {
                    return restore_recovered_registry(backup_path, file);
                }
                return Ok(Self::empty(backup_path));
            }
            Err(_) => return Err("REGISTRY_READ_FAILED: could not read registry.json".into()),
        };
        let version = match declared_version(&bytes) {
            Ok(version) if version > REGISTRY_VERSION => return Err(unsupported_version_error()),
            Ok(version) => version,
            Err(primary_error) => {
                preserve_invalid_primary(&backup_path, &bytes);
                return match load_recovery_candidate(&backup_path)? {
                    Some(file) => restore_recovered_registry(backup_path, file),
                    None => Err(primary_error),
                };
            }
        };
        let mut file = match parse_and_validate_registry(&bytes) {
            Ok(file) => file,
            Err(primary_error) => {
                preserve_invalid_primary(&backup_path, &bytes);
                return match load_recovery_candidate(&backup_path)? {
                    Some(file) => restore_recovered_registry(backup_path, file),
                    None => Err(primary_error),
                };
            }
        };

        if version < REGISTRY_VERSION {
            // Preserve the exact source before migration. A future migration
            // must never make the only copy of an older schema unrecoverable.
            write_generation(&backup_path, &file)?;
            file.version = REGISTRY_VERSION;
            validate_and_normalize_records(&mut file, &HashSet::new())?;
            commit_primary(&backup_path, &file, false)?;
        }
        normalize_statuses(&mut file.sessions);
        Ok(Self::from_file(backup_path, file))
    }

    pub fn empty(backup_path: impl AsRef<Path>) -> Self {
        Self {
            folders: Vec::new(),
            sessions: Vec::new(),
            backup_path: backup_path.as_ref().to_path_buf(),
        }
    }

    /// Atomic write: serialize → sync a same-directory temp file → replace registry.json.
    pub fn save(&self) -> Result<(), String> {
        self.save_with_directory_sync(sync_directory)
    }

    fn save_with_directory_sync(
        &self,
        directory_sync: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut file = RegistryFile {
            version: REGISTRY_VERSION,
            folders: self.folders.clone(),
            sessions: self.sessions.clone(),
        };
        validate_and_normalize_records(&mut file, &HashSet::new())?;
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|_| "REGISTRY_WRITE_FAILED: could not serialize registry".to_string())?;
        atomic_write_with_directory_sync(
            &self.registry_path(),
            &bytes,
            "REGISTRY_WRITE_FAILED",
            directory_sync,
        )?;
        // Recovery files are post-commit safeguards. A failure here must not
        // report the already-committed mutation as failed to its caller.
        let _ = write_last_good(&self.backup_path, &file);
        let _ = write_generation(&self.backup_path, &file);
        let _ = prune_generations(&self.backup_path);
        Ok(())
    }

    pub fn merge(&mut self, mut imported: RegistryFile) -> Result<(), String> {
        validate_version(imported.version)?;
        let mut current = RegistryFile {
            version: REGISTRY_VERSION,
            folders: self.folders.clone(),
            sessions: self.sessions.clone(),
        };
        validate_and_normalize_records(&mut current, &HashSet::new())?;
        let current_folder_ids: HashSet<String> =
            current.folders.iter().map(|item| item.id.clone()).collect();
        validate_and_normalize_records(&mut imported, &current_folder_ids)?;

        let mut folders = current.folders;
        let mut sessions = current.sessions;
        let mut folder_ids: HashSet<String> = folders.iter().map(|item| item.id.clone()).collect();
        let mut session_ids: HashSet<String> =
            sessions.iter().map(|item| item.id.clone()).collect();

        folders.extend(
            imported
                .folders
                .into_iter()
                .filter(|item| folder_ids.insert(item.id.clone())),
        );
        sessions.extend(imported.sessions.into_iter().filter_map(|mut item| {
            if session_ids.insert(item.id.clone()) {
                item.status = Status::Stopped;
                Some(item)
            } else {
                None
            }
        }));

        let candidate = Self {
            folders,
            sessions,
            backup_path: self.backup_path.clone(),
        };
        candidate.save()?;
        self.folders = candidate.folders;
        self.sessions = candidate.sessions;
        Ok(())
    }

    pub fn import_from(&mut self, path: impl AsRef<Path>) -> Result<(), String> {
        let bytes = fs::read(path)
            .map_err(|_| "REGISTRY_IMPORT_FAILED: could not read import file".to_string())?;
        let imported = serde_json::from_slice(&bytes)
            .map_err(|_| "REGISTRY_IMPORT_FAILED: import file is not valid JSON".to_string())?;
        self.merge(imported)
    }

    pub fn registry_path(&self) -> PathBuf {
        self.backup_path.join("registry.json")
    }

    pub fn snapshot(&self) -> AppState {
        AppState {
            folders: self.folders.clone(),
            sessions: self.sessions.clone(),
        }
    }

    fn from_file(backup_path: PathBuf, file: RegistryFile) -> Self {
        Self {
            folders: file.folders,
            sessions: file.sessions,
            backup_path,
        }
    }
}

fn validate_version(version: u32) -> Result<(), String> {
    if (OLDEST_SUPPORTED_REGISTRY_VERSION..=REGISTRY_VERSION).contains(&version) {
        Ok(())
    } else {
        Err(unsupported_version_error())
    }
}

fn unsupported_version_error() -> String {
    "REGISTRY_VERSION_UNSUPPORTED: registry schema version is not supported".into()
}

fn declared_version(bytes: &[u8]) -> Result<u32, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "REGISTRY_INVALID: registry.json is not valid JSON".to_string())?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| "REGISTRY_INVALID: registry version is missing or invalid".to_string())?;
    Ok(version)
}

fn parse_and_validate_registry(bytes: &[u8]) -> Result<RegistryFile, String> {
    let mut file: RegistryFile = serde_json::from_slice(bytes)
        .map_err(|_| "REGISTRY_INVALID: registry.json is not valid JSON".to_string())?;
    validate_version(file.version)?;
    validate_and_normalize_records(&mut file, &HashSet::new())?;
    Ok(file)
}

fn recovery_envelope(file: &RegistryFile) -> Result<RegistryRecovery, String> {
    let canonical = serde_json::to_vec(file)
        .map_err(|_| "REGISTRY_BACKUP_FAILED: could not serialize registry".to_string())?;
    Ok(RegistryRecovery {
        format_version: RECOVERY_FORMAT_VERSION,
        created_at: Utc::now().to_rfc3339(),
        sha256: sha256_hex(&canonical),
        registry: file.clone(),
    })
}

fn recovery_bytes(file: &RegistryFile) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(&recovery_envelope(file)?)
        .map_err(|_| "REGISTRY_BACKUP_FAILED: could not serialize recovery file".to_string())
}

fn write_last_good(backup_path: &Path, file: &RegistryFile) -> Result<(), String> {
    atomic_write(
        &backup_path.join("registry.last-good.json"),
        &recovery_bytes(file)?,
        "REGISTRY_BACKUP_FAILED",
    )
}

fn write_generation(backup_path: &Path, file: &RegistryFile) -> Result<(), String> {
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.9fZ");
    let unique = uuid::Uuid::new_v4().hyphenated();
    let path = backup_path.join("backups").join(format!(
        "registry-v{}-{timestamp}-{unique}.json",
        file.version
    ));
    atomic_write(&path, &recovery_bytes(file)?, "REGISTRY_BACKUP_FAILED")
}

fn generation_paths_newest_first(backup_path: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<_> = fs::read_dir(backup_path.join("backups"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("registry-v") && name.ends_with(".json"))
        })
        .collect();
    paths.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    paths
}

fn prune_generations(backup_path: &Path) -> Result<(), String> {
    for path in generation_paths_newest_first(backup_path)
        .into_iter()
        .skip(MAX_GENERATIONS)
    {
        fs::remove_file(path)
            .map_err(|_| "REGISTRY_BACKUP_FAILED: could not rotate old generation".to_string())?;
    }
    Ok(())
}

fn read_recovery(path: &Path) -> Result<RegistryFile, String> {
    let bytes = fs::read(path)
        .map_err(|_| "REGISTRY_BACKUP_INVALID: could not read recovery file".to_string())?;
    let mut envelope: RegistryRecovery = serde_json::from_slice(&bytes)
        .map_err(|_| "REGISTRY_BACKUP_INVALID: recovery file is not valid JSON".to_string())?;
    if envelope.format_version != RECOVERY_FORMAT_VERSION {
        return Err("REGISTRY_BACKUP_INVALID: recovery format is not supported".into());
    }
    if envelope.registry.version > REGISTRY_VERSION {
        return Err(unsupported_version_error());
    }
    let canonical = serde_json::to_vec(&envelope.registry)
        .map_err(|_| "REGISTRY_BACKUP_INVALID: could not verify recovery file".to_string())?;
    if sha256_hex(&canonical) != envelope.sha256 {
        return Err("REGISTRY_BACKUP_INVALID: recovery checksum does not match".into());
    }
    validate_version(envelope.registry.version)?;
    validate_and_normalize_records(&mut envelope.registry, &HashSet::new())?;
    Ok(envelope.registry)
}

fn load_recovery_candidate(backup_path: &Path) -> Result<Option<RegistryFile>, String> {
    let last_good = backup_path.join("registry.last-good.json");
    if last_good.exists() {
        match read_recovery(&last_good) {
            Ok(file) => return Ok(Some(file)),
            Err(error) if error.starts_with("REGISTRY_VERSION_UNSUPPORTED:") => return Err(error),
            Err(_) => {}
        }
    }
    for path in generation_paths_newest_first(backup_path) {
        match read_recovery(&path) {
            Ok(file) => return Ok(Some(file)),
            Err(error) if error.starts_with("REGISTRY_VERSION_UNSUPPORTED:") => return Err(error),
            Err(_) => {}
        }
    }
    Ok(None)
}

fn restore_recovered_registry(
    backup_path: PathBuf,
    mut file: RegistryFile,
) -> Result<Registry, String> {
    if file.version < REGISTRY_VERSION {
        write_generation(&backup_path, &file)?;
        file.version = REGISTRY_VERSION;
    }
    validate_and_normalize_records(&mut file, &HashSet::new())?;
    commit_primary(&backup_path, &file, false)?;
    normalize_statuses(&mut file.sessions);
    Ok(Registry::from_file(backup_path, file))
}

fn commit_primary(
    backup_path: &Path,
    file: &RegistryFile,
    create_generation: bool,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(file)
        .map_err(|_| "REGISTRY_WRITE_FAILED: could not serialize registry".to_string())?;
    atomic_write(
        &backup_path.join("registry.json"),
        &bytes,
        "REGISTRY_WRITE_FAILED",
    )?;
    // Recovery maintenance is post-commit and must not make a successful
    // registry mutation look failed to callers that would roll memory back.
    let _ = write_last_good(backup_path, file);
    if create_generation {
        let _ = write_generation(backup_path, file);
        let _ = prune_generations(backup_path);
    }
    Ok(())
}

fn preserve_invalid_primary(backup_path: &Path, bytes: &[u8]) {
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.9fZ");
    let unique = uuid::Uuid::new_v4().hyphenated();
    let path = backup_path
        .join("recovery")
        .join(format!("registry.corrupt-{timestamp}-{unique}.json"));
    let _ = atomic_write(&path, bytes, "REGISTRY_RECOVERY_COPY_FAILED");
}

fn normalize_statuses(sessions: &mut [Session]) {
    for session in sessions {
        session.status = Status::Stopped;
    }
}

fn validate_and_normalize_records(
    file: &mut RegistryFile,
    external_folder_ids: &HashSet<String>,
) -> Result<(), String> {
    let mut known_folder_ids = external_folder_ids.clone();
    let mut file_folder_ids = HashSet::new();
    for folder in &mut file.folders {
        folder.id = canonical_uuid(&folder.id, "folder")?;
        if !is_supported_folder_path(&folder.path) {
            return Err(
                "REGISTRY_INVALID: folder path must be absolute or use a supported tilde root"
                    .into(),
            );
        }
        if !file_folder_ids.insert(folder.id.clone()) {
            return Err("REGISTRY_INVALID: duplicate folder id".into());
        }
        known_folder_ids.insert(folder.id.clone());
    }

    let mut session_ids = HashSet::new();
    for session in &mut file.sessions {
        session.id = canonical_uuid(&session.id, "session")?;
        session.folder_id = canonical_uuid(&session.folder_id, "folder reference")?;
        if !session_ids.insert(session.id.clone()) {
            return Err("REGISTRY_INVALID: duplicate session id".into());
        }
        if !known_folder_ids.contains(&session.folder_id) {
            return Err("REGISTRY_INVALID: session references an unknown folder".into());
        }
        match (&session.tool, &session.codex_profile) {
            (Tool::Codex, Some(profile)) => validate_profile_name(profile)
                .map_err(|_| "REGISTRY_INVALID: Codex profile name is not supported".to_string())?,
            (Tool::Codex, None) => {}
            (_, Some(_)) => {
                return Err("REGISTRY_INVALID: only Codex sessions may have a profile".into())
            }
            (_, None) => {}
        }
    }
    Ok(())
}

fn is_supported_folder_path(path: &str) -> bool {
    is_supported_folder_path_for_platform(path, cfg!(windows))
}

fn is_supported_folder_path_for_platform(path: &str, windows: bool) -> bool {
    if path.is_empty() {
        return false;
    }
    if windows {
        if path == "~" || path.starts_with("~\\") || path.starts_with("~/") {
            return true;
        }
        let bytes = path.as_bytes();
        let drive_absolute = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/');
        let unc_absolute = path.starts_with("\\\\") || path.starts_with("//");
        drive_absolute || unc_absolute
    } else {
        path == "~" || path.starts_with("~/") || path.starts_with('/')
    }
}

fn canonical_uuid(value: &str, kind: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| format!("REGISTRY_INVALID: {kind} id must be a UUID"))
}

fn resolve_backup_path(path: &Path) -> Result<PathBuf, String> {
    match path.to_str() {
        Some(path) => crate::settings::expand_tilde(path),
        None => Ok(path.to_path_buf()),
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "REGISTRY_WRITE_FAILED: could not sync backup directory".to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Status, Tool};
    use tempfile::tempdir;

    const FOLDER_ONE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const FOLDER_TWO: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SESSION_ONE: &str = "11111111-1111-4111-8111-111111111111";
    const SESSION_TWO: &str = "22222222-2222-4222-8222-222222222222";
    const SESSION_THREE: &str = "33333333-3333-4333-8333-333333333333";

    fn folder(id: &str, name: &str) -> Folder {
        Folder {
            id: id.into(),
            name: name.into(),
            path: if cfg!(windows) {
                format!(r"C:\synthetic\{name}")
            } else {
                format!("/synthetic/{name}")
            },
        }
    }

    fn session(id: &str, folder_id: &str, status: Status) -> Session {
        Session {
            id: id.into(),
            folder_id: folder_id.into(),
            tool: Tool::Codex,
            title: format!("Synthetic session {id}"),
            cli_session_id: Some(format!("cli-{id}")),
            status,
            model: None,
            extra_args: vec!["--synthetic".into()],
            codex_profile: None,
            created_at: "2026-01-02T03:04:05Z".into(),
            last_active_at: "2026-01-02T04:05:06Z".into(),
            was_open_in_tab: true,
        }
    }

    fn generation_paths(root: &Path) -> Vec<PathBuf> {
        let backups = root.join("backups");
        let mut paths: Vec<_> = fs::read_dir(backups)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("registry-v") && name.ends_with(".json"))
            })
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn version_one_upgrade_preserves_exact_cli_identity_and_source_generation() {
        let root = tempdir().unwrap();
        let source = RegistryFile {
            version: 1,
            folders: vec![folder(FOLDER_ONE, "alpha")],
            sessions: vec![session(SESSION_ONE, FOLDER_ONE, Status::Stopped)],
        };
        fs::write(
            root.path().join("registry.json"),
            serde_json::to_vec_pretty(&source).unwrap(),
        )
        .unwrap();

        let loaded = Registry::load_from_backup_path(root.path()).unwrap();
        let primary: serde_json::Value =
            serde_json::from_slice(&fs::read(root.path().join("registry.json")).unwrap()).unwrap();
        let generations = generation_paths(root.path());

        assert_eq!(primary["version"], 2);
        assert_eq!(
            loaded.sessions[0].cli_session_id.as_deref(),
            Some("cli-11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(generations.len(), 1);
        let generation: serde_json::Value =
            serde_json::from_slice(&fs::read(&generations[0]).unwrap()).unwrap();
        assert_eq!(generation["registry"]["version"], 1);
        assert!(generation["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64));
        assert!(root.path().join("registry.last-good.json").is_file());
    }

    #[test]
    fn corrupt_primary_recovers_latest_exact_session_identity() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "alpha"));
        registry
            .sessions
            .push(session(SESSION_ONE, FOLDER_ONE, Status::Stopped));
        registry.save().unwrap();
        fs::write(root.path().join("registry.json"), b"{broken").unwrap();

        let recovered = Registry::load_from_backup_path(root.path()).unwrap();

        assert_eq!(
            recovered.sessions[0].cli_session_id,
            registry.sessions[0].cli_session_id
        );
        let primary: serde_json::Value =
            serde_json::from_slice(&fs::read(root.path().join("registry.json")).unwrap()).unwrap();
        assert_eq!(primary["version"], 2);
        let diagnostics = fs::read_dir(root.path().join("recovery"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("registry.corrupt-"))
            })
            .count();
        assert_eq!(diagnostics, 1);
    }

    #[test]
    fn missing_primary_recovers_instead_of_starting_with_an_empty_registry() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "alpha"));
        registry
            .sessions
            .push(session(SESSION_ONE, FOLDER_ONE, Status::Stopped));
        registry.save().unwrap();
        fs::rename(
            root.path().join("registry.json"),
            root.path().join("registry.missing-source.json"),
        )
        .unwrap();

        let recovered = Registry::load_from_backup_path(root.path()).unwrap();

        assert_eq!(
            recovered.sessions[0].cli_session_id,
            registry.sessions[0].cli_session_id
        );
        assert!(root.path().join("registry.json").is_file());
    }

    #[test]
    fn invalid_last_good_checksum_falls_back_to_newest_valid_generation() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "first"));
        registry
            .sessions
            .push(session(SESSION_ONE, FOLDER_ONE, Status::Stopped));
        registry.save().unwrap();
        registry.folders[0].name = "newest".into();
        registry.save().unwrap();

        fs::write(root.path().join("registry.json"), b"{broken").unwrap();
        let last_good_path = root.path().join("registry.last-good.json");
        let mut last_good: serde_json::Value =
            serde_json::from_slice(&fs::read(&last_good_path).unwrap()).unwrap();
        last_good["sha256"] = serde_json::Value::String("0".repeat(64));
        fs::write(
            &last_good_path,
            serde_json::to_vec_pretty(&last_good).unwrap(),
        )
        .unwrap();

        let recovered = Registry::load_from_backup_path(root.path()).unwrap();

        assert_eq!(recovered.folders[0].name, "newest");
        assert_eq!(
            recovered.sessions[0].cli_session_id,
            registry.sessions[0].cli_session_id
        );
    }

    #[test]
    fn future_registry_version_is_never_replaced_by_older_recovery_data() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "recoverable"));
        registry.save().unwrap();
        let future = br#"{"version":999,"folders":[],"sessions":[]}"#;
        fs::write(root.path().join("registry.json"), future).unwrap();

        let error = match Registry::load_from_backup_path(root.path()) {
            Ok(_) => panic!("future registry version was accepted"),
            Err(error) => error,
        };

        assert!(error.starts_with("REGISTRY_VERSION_UNSUPPORTED:"));
        assert_eq!(fs::read(root.path().join("registry.json")).unwrap(), future);
    }

    #[test]
    fn registry_generation_retention_keeps_only_ten_newest_snapshots() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "generation-0"));

        for generation in 0..12 {
            registry.folders[0].name = format!("generation-{generation}");
            registry.save().unwrap();
        }

        assert_eq!(generation_paths(root.path()).len(), 10);
        let recovered = Registry::load_from_backup_path(root.path()).unwrap();
        assert_eq!(recovered.folders[0].name, "generation-11");
    }

    #[test]
    fn missing_registry_loads_as_empty() {
        let root = tempdir().unwrap();

        let registry = Registry::load_from_backup_path(root.path()).unwrap();

        assert!(registry.folders.is_empty());
        assert!(registry.sessions.is_empty());
    }

    #[test]
    fn save_round_trips_versioned_camel_case_json() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "alpha"));
        registry
            .sessions
            .push(session(SESSION_ONE, FOLDER_ONE, Status::Stopped));

        registry.save().unwrap();
        let raw = std::fs::read_to_string(root.path().join("registry.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let loaded = Registry::load_from_backup_path(root.path()).unwrap();

        assert_eq!(json["version"], 2);
        assert_eq!(json["sessions"][0]["folderId"], FOLDER_ONE);
        assert!(json["sessions"][0]["codexProfile"].is_null());
        assert_eq!(loaded.snapshot(), registry.snapshot());
    }

    #[test]
    fn version_one_without_profile_loads_as_base_config_and_upgrades_on_save() {
        let root = tempdir().unwrap();
        let legacy = serde_json::json!({
            "version": 1,
            "folders": [folder(FOLDER_ONE, "alpha")],
            "sessions": [session(SESSION_ONE, FOLDER_ONE, Status::Stopped)],
        });
        let mut legacy = legacy;
        legacy["sessions"][0]
            .as_object_mut()
            .unwrap()
            .remove("codexProfile");
        std::fs::write(
            root.path().join("registry.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();

        let registry = Registry::load_from_backup_path(root.path()).unwrap();
        assert_eq!(registry.sessions[0].codex_profile, None);
        registry.save().unwrap();

        let upgraded: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("registry.json")).unwrap())
                .unwrap();
        assert_eq!(upgraded["version"], 2);
        assert!(upgraded["sessions"][0]["codexProfile"].is_null());
    }

    #[test]
    fn load_normalizes_every_session_status_to_stopped() {
        let root = tempdir().unwrap();
        let file = RegistryFile {
            version: 1,
            folders: vec![folder(FOLDER_ONE, "alpha")],
            sessions: vec![
                session(SESSION_ONE, FOLDER_ONE, Status::Running),
                session(SESSION_TWO, FOLDER_ONE, Status::Waiting),
                session(SESSION_THREE, FOLDER_ONE, Status::Stopped),
            ],
        };
        std::fs::write(
            root.path().join("registry.json"),
            serde_json::to_vec(&file).unwrap(),
        )
        .unwrap();

        let loaded = Registry::load_from_backup_path(root.path()).unwrap();

        assert!(loaded
            .sessions
            .iter()
            .all(|session| session.status == Status::Stopped));
    }

    #[test]
    fn save_atomically_replaces_existing_registry() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "before"));
        registry.save().unwrap();
        registry.folders[0].name = "after".into();

        registry.save().unwrap();

        let loaded = Registry::load_from_backup_path(root.path()).unwrap();
        assert_eq!(loaded.folders[0].name, "after");
        let unexpected: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                !matches!(
                    entry.file_name().to_str(),
                    Some("registry.json" | "registry.last-good.json" | "backups")
                )
            })
            .collect();
        assert!(unexpected.is_empty(), "temporary file was not renamed");
    }

    #[test]
    fn post_commit_directory_sync_failure_is_nonfatal_and_disk_matches_memory() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "committed"));

        registry
            .save_with_directory_sync(|_| {
                Err("REGISTRY_WRITE_FAILED: synthetic directory sync failure".into())
            })
            .unwrap();

        let loaded = Registry::load_from_backup_path(root.path()).unwrap();
        assert_eq!(loaded.snapshot(), registry.snapshot());
    }

    #[test]
    fn load_and_import_reject_relative_folder_paths_without_requiring_existence() {
        let root = tempdir().unwrap();
        let mut invalid_folder = folder(FOLDER_ONE, "alpha");
        invalid_folder.path = "relative/project".into();
        let invalid = RegistryFile {
            version: 1,
            folders: vec![invalid_folder],
            sessions: Vec::new(),
        };
        std::fs::write(
            root.path().join("registry.json"),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert!(Registry::load_from_backup_path(root.path()).is_err());

        let target = tempdir().unwrap();
        let mut registry = Registry::empty(target.path());
        let import_path = root.path().join("import.json");
        std::fs::write(&import_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(registry.import_from(import_path).is_err());

        let mut missing_absolute = folder(FOLDER_ONE, "missing");
        missing_absolute.path = if cfg!(windows) {
            r"C:\synthetic\does-not-need-to-exist".into()
        } else {
            "/synthetic/does-not-need-to-exist".into()
        };
        registry
            .merge(RegistryFile {
                version: 1,
                folders: vec![missing_absolute],
                sessions: Vec::new(),
            })
            .unwrap();
    }

    #[test]
    fn folder_path_validation_covers_native_and_foreign_representations() {
        for path in [
            r"C:\synthetic\project",
            "C:/synthetic/project",
            r"\\server\share",
        ] {
            assert!(is_supported_folder_path_for_platform(path, true));
        }
        for path in ["C:relative", "/unix/on/windows", r"~\project\..\relative"] {
            // Native Windows tilde paths are accepted without canonicalizing
            // their content; only the foreign Unix absolute form is rejected.
            if path.starts_with('~') {
                assert!(is_supported_folder_path_for_platform(path, true));
            } else {
                assert!(!is_supported_folder_path_for_platform(path, true));
            }
        }
        assert!(is_supported_folder_path_for_platform("~/project", false));
        assert!(is_supported_folder_path_for_platform(
            "/synthetic/project",
            false
        ));
        assert!(!is_supported_folder_path_for_platform(
            r"C:\synthetic\project",
            false
        ));
        assert!(!is_supported_folder_path_for_platform(
            "relative/project",
            false
        ));
    }

    #[test]
    fn merge_adds_only_new_folder_and_session_ids_and_persists() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "local"));
        registry
            .sessions
            .push(session(SESSION_ONE, FOLDER_ONE, Status::Stopped));

        registry
            .merge(RegistryFile {
                version: 1,
                folders: vec![
                    folder(FOLDER_ONE, "imported duplicate"),
                    folder(FOLDER_TWO, "new"),
                ],
                sessions: vec![
                    session(SESSION_ONE, FOLDER_ONE, Status::Running),
                    session(SESSION_TWO, FOLDER_TWO, Status::Waiting),
                ],
            })
            .unwrap();

        assert_eq!(registry.folders.len(), 2);
        assert_eq!(registry.sessions.len(), 2);
        assert_eq!(registry.folders[0].name, "local");
        assert_eq!(
            registry.sessions[0].title,
            format!("Synthetic session {SESSION_ONE}")
        );
        assert_eq!(registry.sessions[1].status, Status::Stopped);
        let reloaded = Registry::load_from_backup_path(root.path()).unwrap();
        assert_eq!(reloaded.folders.len(), 2);
        assert_eq!(reloaded.sessions.len(), 2);
    }

    #[test]
    fn load_rejects_invalid_ids_and_dangling_folder_references() {
        let root = tempdir().unwrap();
        let invalid_files = [
            RegistryFile {
                version: 1,
                folders: vec![folder(FOLDER_ONE, "alpha")],
                sessions: vec![session("not-a-uuid", FOLDER_ONE, Status::Stopped)],
            },
            RegistryFile {
                version: 1,
                folders: vec![folder("not-a-uuid", "alpha")],
                sessions: Vec::new(),
            },
            RegistryFile {
                version: 1,
                folders: vec![folder(FOLDER_ONE, "alpha")],
                sessions: vec![session(SESSION_ONE, FOLDER_TWO, Status::Stopped)],
            },
        ];

        for file in invalid_files {
            std::fs::write(
                root.path().join("registry.json"),
                serde_json::to_vec(&file).unwrap(),
            )
            .unwrap();
            assert!(Registry::load_from_backup_path(root.path()).is_err());
        }
    }

    #[test]
    fn registry_rejects_profiles_for_other_tools_and_unsafe_codex_names() {
        let root = tempdir().unwrap();
        let mut non_codex = session(SESSION_ONE, FOLDER_ONE, Status::Stopped);
        non_codex.tool = Tool::Terminal;
        non_codex.codex_profile = Some("synthetic-profile".into());
        let mut unsafe_codex = session(SESSION_TWO, FOLDER_ONE, Status::Stopped);
        unsafe_codex.codex_profile = Some("unsafe&profile".into());

        for session in [non_codex, unsafe_codex] {
            let file = RegistryFile {
                version: REGISTRY_VERSION,
                folders: vec![folder(FOLDER_ONE, "alpha")],
                sessions: vec![session],
            };
            std::fs::write(
                root.path().join("registry.json"),
                serde_json::to_vec(&file).unwrap(),
            )
            .unwrap();
            assert!(Registry::load_from_backup_path(root.path()).is_err());
        }
    }

    #[test]
    fn merge_and_import_reject_invalid_session_ids() {
        let root = tempdir().unwrap();
        let mut registry = Registry::empty(root.path());
        registry.folders.push(folder(FOLDER_ONE, "alpha"));
        registry.save().unwrap();
        let invalid = RegistryFile {
            version: 1,
            folders: Vec::new(),
            sessions: vec![session("not-a-uuid", FOLDER_ONE, Status::Stopped)],
        };

        assert!(registry.merge(invalid.clone()).is_err());

        let import_path = root.path().join("import.json");
        std::fs::write(&import_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(registry.import_from(import_path).is_err());
    }
}
