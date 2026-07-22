//! Folder + session registry with crash-safe persistence.
//! SPEC.md §3. Phase 2 implements.
//!
//! Invariants:
//! - `registry.json` (under settings.backup_path, default ~/.anchor/sessions)
//!   is written on EVERY mutation, via temp-file + atomic rename.
//! - On load, every session's status is normalized to `stopped` (no process
//!   survives an app quit in v1).

#![allow(dead_code)] // Used by later Phase 2 orchestration tasks.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::models::{AppState, Folder, Session, Status};

const REGISTRY_VERSION: u32 = 1;

/// On-disk shape of registry.json (versioned for future migration).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegistryFile {
    pub version: u32,
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
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
                return Ok(Self::empty(backup_path));
            }
            Err(_) => return Err("REGISTRY_READ_FAILED: could not read registry.json".into()),
        };
        let mut file: RegistryFile = serde_json::from_slice(&bytes)
            .map_err(|_| "REGISTRY_INVALID: registry.json is not valid JSON".to_string())?;
        validate_version(file.version)?;
        validate_and_normalize_records(&mut file, &HashSet::new())?;
        normalize_statuses(&mut file.sessions);

        Ok(Self {
            folders: file.folders,
            sessions: file.sessions,
            backup_path,
        })
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
        fs::create_dir_all(&self.backup_path)
            .map_err(|_| "REGISTRY_WRITE_FAILED: could not create backup directory".to_string())?;
        let mut file = RegistryFile {
            version: REGISTRY_VERSION,
            folders: self.folders.clone(),
            sessions: self.sessions.clone(),
        };
        validate_and_normalize_records(&mut file, &HashSet::new())?;
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|_| "REGISTRY_WRITE_FAILED: could not serialize registry".to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.backup_path)
            .map_err(|_| "REGISTRY_WRITE_FAILED: could not create temporary file".to_string())?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "REGISTRY_WRITE_FAILED: could not sync temporary file".to_string())?;

        // Persist performs the same-directory atomic replacement that prevents a
        // crash from exposing a partially written registry.
        temporary
            .persist(self.registry_path())
            .map_err(|_| "REGISTRY_WRITE_FAILED: could not replace registry.json".to_string())?;
        // The durable temp file has already been atomically committed. A
        // directory fsync failure is post-commit and therefore best-effort:
        // reporting Err here would make callers roll memory back behind disk.
        let _ = directory_sync(&self.backup_path);
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
}

fn validate_version(version: u32) -> Result<(), String> {
    if version == REGISTRY_VERSION {
        Ok(())
    } else {
        Err("REGISTRY_VERSION_UNSUPPORTED: registry schema version is not supported".into())
    }
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
            created_at: "2026-01-02T03:04:05Z".into(),
            last_active_at: "2026-01-02T04:05:06Z".into(),
            was_open_in_tab: true,
        }
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

        assert_eq!(json["version"], 1);
        assert_eq!(json["sessions"][0]["folderId"], FOLDER_ONE);
        assert_eq!(loaded.snapshot(), registry.snapshot());
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
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != "registry.json")
            .collect();
        assert!(leftovers.is_empty(), "temporary file was not renamed");
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
