//! Shared crash-safe file primitives for user data that must survive app updates.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn atomic_write(path: &Path, bytes: &[u8], error_prefix: &str) -> Result<(), String> {
    atomic_write_with_directory_sync(path, bytes, error_prefix, sync_directory)
}

pub fn atomic_write_with_directory_sync(
    path: &Path,
    bytes: &[u8],
    error_prefix: &str,
    directory_sync: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{error_prefix}: path has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|_| format!("{error_prefix}: could not create parent directory"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| format!("{error_prefix}: could not create temporary file"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| format!("{error_prefix}: could not sync temporary file"))?;
    let mut replace_attempt = 0;
    loop {
        match temporary.persist(path) {
            Ok(_) => break,
            Err(error) => {
                let Some(delay) =
                    replace_retry_delay(replace_attempt, &error.error, cfg!(target_os = "windows"))
                else {
                    return Err(format!(
                        "{error_prefix}: could not replace destination file"
                    ));
                };
                // Windows scanners and network drives can briefly hold the old
                // file open. Retain the same synced temp file and retry its
                // atomic replacement instead of rewriting or losing the data.
                temporary = error.file;
                std::thread::sleep(delay);
                replace_attempt += 1;
            }
        }
    }

    // The atomic replacement is already committed. Directory sync is
    // best-effort because reporting failure now would put memory behind disk.
    let _ = directory_sync(parent);
    Ok(())
}

fn replace_retry_delay(attempt: usize, error: &io::Error, windows: bool) -> Option<Duration> {
    const BACKOFF_MS: [u64; 4] = [20, 50, 100, 200];
    if !windows || attempt >= BACKOFF_MS.len() {
        return None;
    }
    let sharing_violation = matches!(error.raw_os_error(), Some(32 | 33));
    let transient_kind = matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock
    );
    (sharing_violation || transient_kind).then(|| Duration::from_millis(BACKOFF_MS[attempt]))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "DURABLE_WRITE_FAILED: could not sync parent directory".to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sha256_matches_the_standard_synthetic_fixture() {
        assert_eq!(
            sha256_hex(b"anchor"),
            "79bfb0e2ba76b9d447606ddbcc494834f05a4c11deb052e74b49ea307a3c5bcd"
        );
    }

    #[test]
    fn atomic_write_replaces_complete_contents() {
        let root = tempdir().unwrap();
        let path = root.path().join("nested/data.json");
        atomic_write(&path, b"before", "SYNTHETIC_WRITE_FAILED").unwrap();

        atomic_write(&path, b"after", "SYNTHETIC_WRITE_FAILED").unwrap();

        assert_eq!(fs::read(path).unwrap(), b"after");
    }

    #[test]
    fn windows_replace_retries_only_bounded_transient_failures() {
        let sharing_violation = io::Error::from_raw_os_error(32);
        assert_eq!(
            replace_retry_delay(0, &sharing_violation, true),
            Some(Duration::from_millis(20))
        );
        assert_eq!(replace_retry_delay(4, &sharing_violation, true), None);
        assert_eq!(replace_retry_delay(0, &sharing_violation, false), None);
        assert_eq!(
            replace_retry_delay(0, &io::Error::from(io::ErrorKind::NotFound), true),
            None
        );
    }
}
