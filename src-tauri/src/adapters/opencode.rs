//! opencode adapter (SPEC.md §5).
//! Launch: `opencode` run in the folder (→ Discover).
//! Discovery: read opencode's sqlite DB (platform data dir, e.g.
//! `~/.local/share/opencode/opencode.db`) READ-ONLY (immutable/read-only open
//! flags to avoid locking): newest session row with directory == folder path
//! and created ≥ launch time.
//! Resume: `opencode --session <id>` run in the folder.

use super::{
    paths_match, session_id_for_resume, validate_extra_args, Adapter, IdCapture, SpawnSpec,
};
use crate::models::{Session, Settings, Tool};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct OpencodeAdapter {
    database_path: Option<PathBuf>,
}

impl Default for OpencodeAdapter {
    fn default() -> Self {
        Self {
            database_path: Self::default_database_path(),
        }
    }
}

impl OpencodeAdapter {
    pub fn default_database_path() -> Option<PathBuf> {
        #[cfg(unix)]
        {
            let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
            Self::resolve_database_path(dirs::home_dir().as_deref(), xdg.as_deref(), None, false)
        }
        #[cfg(windows)]
        {
            Self::resolve_database_path(None, None, dirs::data_dir().as_deref(), true)
        }
        #[cfg(not(any(unix, windows)))]
        {
            dirs::data_dir().map(|data| data.join("opencode/opencode.db"))
        }
    }

    pub fn resolve_database_path(
        home: Option<&Path>,
        xdg_data_home: Option<&Path>,
        windows_data: Option<&Path>,
        windows: bool,
    ) -> Option<PathBuf> {
        if windows {
            return windows_data.map(|data| data.join("opencode/opencode.db"));
        }
        xdg_data_home
            .filter(|path| path.is_absolute())
            .map(|data| data.join("opencode/opencode.db"))
            .or_else(|| home.map(|home| home.join(".local/share/opencode/opencode.db")))
    }

    pub fn with_database_path(path: impl AsRef<Path>) -> Self {
        Self {
            database_path: Some(path.as_ref().to_path_buf()),
        }
    }
}

impl Adapter for OpencodeAdapter {
    fn tool(&self) -> Tool {
        Tool::Opencode
    }

    fn launch(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<(SpawnSpec, IdCapture), String> {
        validate_extra_args(Tool::Opencode, &session.extra_args)?;
        Ok((
            SpawnSpec::new("opencode", session.extra_args.clone(), cwd),
            IdCapture::Discover,
        ))
    }

    fn resume(
        &self,
        session: &Session,
        cwd: &Path,
        _settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        let id = session_id_for_resume(session, Tool::Opencode)?;
        Ok(SpawnSpec::new("opencode", ["--session", id], cwd))
    }

    fn discover_session_id(
        &self,
        cwd: &Path,
        launched_at: SystemTime,
    ) -> Result<Option<String>, String> {
        let Some(path) = self.database_path.as_deref() else {
            return Ok(None);
        };
        let Some(uri) = immutable_sqlite_uri(path) else {
            return Ok(None);
        };
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = match Connection::open_with_flags(uri, flags) {
            Ok(connection) => connection,
            Err(_) => return Ok(None),
        };
        let launched_ms = match launched_at.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis().min(i64::MAX as u128) as i64,
            Err(_) => 0,
        };

        // Schema changes and partial databases are discovery-pending conditions;
        // the active opencode process must remain usable even when metadata moves.
        let mut statement = match connection.prepare(
            "SELECT id, directory FROM session WHERE time_created >= ?1 ORDER BY time_created DESC",
        ) {
            Ok(statement) => statement,
            Err(_) => return Ok(None),
        };
        let rows = match statement.query_map([launched_ms], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(rows) => rows,
            Err(_) => return Ok(None),
        };
        for row in rows.flatten() {
            if !row.0.is_empty() && paths_match(Path::new(&row.1), cwd) {
                return Ok(Some(row.0));
            }
        }
        Ok(None)
    }
}

fn immutable_sqlite_uri(path: &Path) -> Option<String> {
    let absolute = std::fs::canonicalize(path).ok()?;
    immutable_sqlite_uri_text(&absolute.to_string_lossy(), cfg!(windows))
}

pub(crate) fn immutable_sqlite_uri_text(raw: &str, windows: bool) -> Option<String> {
    let replaced = raw.replace('\\', "/");
    let stripped = if replaced
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/"))
    {
        &replaced[4..]
    } else {
        &replaced
    };
    let uri_path = if windows {
        if stripped
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC/"))
        {
            format!("//{}", &stripped[4..])
        } else {
            let drive_path = stripped.trim_start_matches('/');
            if drive_path.as_bytes().get(1) != Some(&b':') {
                return None;
            }
            format!("/{drive_path}")
        }
    } else if stripped.starts_with('/') {
        stripped.to_owned()
    } else {
        return None;
    };
    let mut encoded = String::with_capacity(uri_path.len());
    for byte in uri_path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Some(format!("file:{encoded}?immutable=1"))
}
