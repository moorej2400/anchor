//! Terminal scrollback persistence (SPEC.md §3, §5 `terminal` row).
//! Files: `<backup_path>/scrollback/<session-uuid>.txt`.
//! Pruned per settings.retention_days. Phase 2 implements.

#![allow(dead_code)] // Used by later Phase 2 orchestration tasks.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub struct ScrollbackStore {
    backup_path: PathBuf,
}

impl ScrollbackStore {
    pub fn new(backup_path: impl AsRef<Path>) -> Self {
        Self {
            backup_path: backup_path.as_ref().to_path_buf(),
        }
    }

    pub fn append(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let path = self.session_path(session_id)?;
        let directory = path
            .parent()
            .ok_or_else(|| "SCROLLBACK_PATH_INVALID: scrollback path has no parent".to_string())?;
        fs::create_dir_all(directory).map_err(|_| {
            "SCROLLBACK_WRITE_FAILED: could not create scrollback directory".to_string()
        })?;
        let mut file = open_for_append(&path)
            .map_err(|_| "SCROLLBACK_WRITE_FAILED: could not open scrollback file".to_string())?;
        file.write_all(data)
            .map_err(|_| "SCROLLBACK_WRITE_FAILED: could not append scrollback".to_string())
    }

    /// Atomically replace one transcript. Used when changing backupPath so a
    /// retry overwrites partial staging instead of duplicating scrollback.
    pub fn replace(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let path = self.session_path(session_id)?;
        let directory = path
            .parent()
            .ok_or_else(|| "SCROLLBACK_PATH_INVALID: scrollback path has no parent".to_string())?;
        fs::create_dir_all(directory).map_err(|_| {
            "SCROLLBACK_WRITE_FAILED: could not create scrollback directory".to_string()
        })?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)
            .map_err(|_| "SCROLLBACK_WRITE_FAILED: could not stage scrollback".to_string())?;
        temporary
            .write_all(data)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "SCROLLBACK_WRITE_FAILED: could not sync scrollback".to_string())?;
        temporary
            .persist(path)
            .map_err(|_| "SCROLLBACK_WRITE_FAILED: could not replace scrollback".to_string())?;
        Ok(())
    }

    pub fn read(&self, session_id: &str) -> Result<String, String> {
        Ok(String::from_utf8_lossy(&self.read_bytes(session_id)?).into_owned())
    }

    pub fn read_bytes(&self, session_id: &str) -> Result<Vec<u8>, String> {
        let path = self.session_path(session_id)?;
        let mut file = match open_for_read(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("SCROLLBACK_READ_FAILED: could not read scrollback file".into()),
        };
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(|_| "SCROLLBACK_READ_FAILED: could not read scrollback file".to_string())?;
        Ok(contents)
    }

    pub fn delete(&self, session_id: &str) -> Result<(), String> {
        let path = self.session_path(session_id)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if is_link_or_reparse(&metadata) => {
                return Err("SCROLLBACK_DELETE_FAILED: refusing to delete a link".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err("SCROLLBACK_DELETE_FAILED: could not inspect scrollback file".into())
            }
        }
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("SCROLLBACK_DELETE_FAILED: could not delete scrollback file".into()),
        }
    }

    pub fn prune(&self, retention_days: u32) -> Result<(), String> {
        if !(1..=90).contains(&retention_days) {
            return Err(
                "SCROLLBACK_RETENTION_INVALID: retention must be between 1 and 90 days".into(),
            );
        }
        let directory = self.backup_path.join("scrollback");
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err("SCROLLBACK_PRUNE_FAILED: could not read scrollback directory".into())
            }
        };
        let cutoff = Duration::from_secs(u64::from(retention_days) * 86_400);
        let now = SystemTime::now();
        for entry in entries {
            let entry = entry.map_err(|_| {
                "SCROLLBACK_PRUNE_FAILED: could not inspect directory entry".to_string()
            })?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            // Only the canonical filename namespace emitted by session_path is
            // eligible; unrelated user-owned text files must survive pruning.
            if !is_canonical_uuid(stem) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|_| {
                "SCROLLBACK_PRUNE_FAILED: could not inspect scrollback file".to_string()
            })?;
            if is_link_or_reparse(&metadata) || !metadata.is_file() {
                continue;
            }
            let modified = metadata.modified().map_err(|_| {
                "SCROLLBACK_PRUNE_FAILED: scrollback age is unavailable".to_string()
            })?;
            if now.duration_since(modified).unwrap_or_default() > cutoff {
                fs::remove_file(path).map_err(|_| {
                    "SCROLLBACK_PRUNE_FAILED: could not remove expired scrollback".to_string()
                })?;
            }
        }
        Ok(())
    }

    fn session_path(&self, session_id: &str) -> Result<PathBuf, String> {
        // Canonical UUID filenames also exclude traversal and Windows device names.
        let session_id = uuid::Uuid::parse_str(session_id)
            .map_err(|_| "SCROLLBACK_SESSION_INVALID: session id must be a UUID".to_string())?
            .hyphenated()
            .to_string();
        Ok(self
            .backup_path
            .join("scrollback")
            .join(format!("{session_id}.txt")))
    }
}

fn is_canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string() == value)
        .unwrap_or(false)
}

fn open_for_append(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    set_no_follow(&mut options);
    let file = options.open(path)?;
    reject_open_reparse(&file)?;
    Ok(file)
}

fn open_for_read(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    set_no_follow(&mut options);
    let file = options.open(path)?;
    reject_open_reparse(&file)?;
    Ok(file)
}

#[cfg(unix)]
fn set_no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn set_no_follow(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(unix)]
fn reject_open_reparse(_file: &fs::File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn reject_open_reparse(file: &fs::File) -> std::io::Result<()> {
    if is_link_or_reparse(&file.metadata()?) {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "reparse points are not scrollback files",
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

pub fn append(session_id: &str, data: &[u8]) -> Result<(), String> {
    default_store()?.append(session_id, data)
}

pub fn read(session_id: &str) -> Result<String, String> {
    default_store()?.read(session_id)
}

pub fn delete(session_id: &str) -> Result<(), String> {
    default_store()?.delete(session_id)
}

/// Remove scrollback files older than retention_days.
pub fn prune(retention_days: u32) -> Result<(), String> {
    default_store()?.prune(retention_days)
}

pub fn format_restored_scrollback(scrollback: &str) -> String {
    let line_count = scrollback.lines().count();
    let mut restored = scrollback.to_owned();
    if !restored.is_empty() && !restored.ends_with('\n') {
        restored.push('\n');
    }
    restored.push_str(&format!(
        "── restored session · scrollback recovered ({line_count} lines) ──\n"
    ));
    restored
}

fn default_store() -> Result<ScrollbackStore, String> {
    let settings = crate::settings::load()?;
    let backup_path = crate::settings::expand_tilde(&settings.backup_path)?;
    Ok(ScrollbackStore::new(backup_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, FileTimes};
    use std::time::{Duration, SystemTime};
    use tempfile::tempdir;

    const SESSION_ONE: &str = "550e8400-e29b-41d4-a716-446655440000";
    const SESSION_TWO: &str = "123e4567-e89b-12d3-a456-426614174000";

    #[test]
    fn append_and_read_preserve_raw_scrollback() {
        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());

        store.append(SESSION_ONE, b"first\n").unwrap();
        store.append(SESSION_ONE, b"second\n").unwrap();

        assert_eq!(store.read(SESSION_ONE).unwrap(), "first\nsecond\n");
    }

    #[test]
    fn read_is_empty_when_file_is_missing() {
        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());

        assert_eq!(store.read(SESSION_ONE).unwrap(), "");
    }

    #[test]
    fn delete_removes_scrollback_and_is_idempotent() {
        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());
        store.append(SESSION_ONE, b"content").unwrap();

        store.delete(SESSION_ONE).unwrap();
        store.delete(SESSION_ONE).unwrap();

        assert_eq!(store.read(SESSION_ONE).unwrap(), "");
    }

    #[test]
    fn read_lossy_decodes_arbitrary_pty_bytes() {
        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());
        store.append(SESSION_ONE, b"valid\xffbytes").unwrap();

        assert_eq!(store.read(SESSION_ONE).unwrap(), "valid\u{fffd}bytes");
    }

    #[test]
    fn session_paths_require_and_canonicalize_uuid_ids() {
        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());
        let non_canonical = "550E8400E29B41D4A716446655440000";

        store.append(non_canonical, b"content").unwrap();

        assert_eq!(store.read(SESSION_ONE).unwrap(), "content");
        assert!(root
            .path()
            .join(format!("scrollback/{SESSION_ONE}.txt"))
            .is_file());
        for invalid in ["CON", "session-1", "../escape", "550e8400-e29b-41d4-a716"] {
            assert!(store.append(invalid, b"blocked").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn file_operations_refuse_uuid_named_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());
        let directory = root.path().join("scrollback");
        std::fs::create_dir_all(&directory).unwrap();
        let target = root.path().join("outside.txt");
        std::fs::write(&target, b"outside").unwrap();
        let link = directory.join(format!("{SESSION_ONE}.txt"));
        symlink(&target, &link).unwrap();

        assert!(store.append(SESSION_ONE, b"blocked").is_err());
        assert!(store.read(SESSION_ONE).is_err());
        assert!(store.delete(SESSION_ONE).is_err());
        store.prune(1).unwrap();
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"outside");
    }

    #[test]
    fn prune_removes_only_txt_files_older_than_retention() {
        let root = tempdir().unwrap();
        let store = ScrollbackStore::new(root.path());
        store.append(SESSION_ONE, b"old").unwrap();
        store.append(SESSION_TWO, b"new").unwrap();
        let old_path = root.path().join(format!("scrollback/{SESSION_ONE}.txt"));
        let old_file = File::options().write(true).open(old_path).unwrap();
        old_file
            .set_times(
                FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(3 * 86_400)),
            )
            .unwrap();
        let unrelated = root.path().join("scrollback/unrelated.txt");
        std::fs::write(&unrelated, b"keep").unwrap();
        let unrelated_file = File::options().write(true).open(&unrelated).unwrap();
        unrelated_file
            .set_times(
                FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(3 * 86_400)),
            )
            .unwrap();

        store.prune(1).unwrap();

        assert_eq!(store.read(SESSION_ONE).unwrap(), "");
        assert_eq!(store.read(SESSION_TWO).unwrap(), "new");
        assert!(unrelated.exists());
    }

    #[test]
    fn restored_scrollback_has_exact_divider_and_line_count() {
        let formatted = format_restored_scrollback("first\nsecond\n");

        assert_eq!(
            formatted,
            "first\nsecond\n── restored session · scrollback recovered (2 lines) ──\n"
        );
    }
}
