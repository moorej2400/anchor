//! Shared crash-safe file primitives for user data that must survive app updates.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;

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
    temporary
        .persist(path)
        .map_err(|_| format!("{error_prefix}: could not replace destination file"))?;

    // The atomic replacement is already committed. Directory sync is
    // best-effort because reporting failure now would put memory behind disk.
    let _ = directory_sync(parent);
    Ok(())
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
}
