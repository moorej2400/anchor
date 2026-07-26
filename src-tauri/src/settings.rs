//! Settings load/save (SPEC.md §3, §7). Phase 2 implements.
//! settings.json lives in the app config/data dir; env-var VALUES are user
//! secrets — they stay local, are masked in the UI, and must never appear in
//! logs, error messages, or committed files (public repo).

#![allow(dead_code)] // Used by later Phase 2 orchestration tasks.

use std::path::{Path, PathBuf};
use std::{fs, io::Write};

use crate::models::Settings;

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn platform() -> Result<Self, String> {
        let config = dirs::config_dir().ok_or_else(|| {
            "SETTINGS_PATH_UNAVAILABLE: platform config directory not found".to_string()
        })?;
        Ok(Self::new(config.join("anchor/settings.json")))
    }

    pub fn load(&self) -> Result<Settings, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Settings::default());
            }
            Err(_) => return Err("SETTINGS_READ_FAILED: could not read settings.json".into()),
        };
        let settings: Settings = serde_json::from_slice(&bytes)
            .map_err(|_| "SETTINGS_INVALID: settings.json is not valid JSON".to_string())?;
        validate(&settings)?;
        Ok(settings)
    }

    pub fn save(&self, settings: &Settings) -> Result<(), String> {
        validate(settings)?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "SETTINGS_PATH_INVALID: settings path has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not create config directory".to_string())?;
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not serialize settings".to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not create temporary file".to_string())?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not sync temporary file".to_string())?;
        temporary
            .persist(&self.path)
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not replace settings.json".to_string())?;
        Ok(())
    }
}

pub fn load() -> Result<Settings, String> {
    SettingsStore::platform()?.load()
}

pub fn save(settings: &Settings) -> Result<(), String> {
    SettingsStore::platform()?.save(settings)
}

pub fn validate(settings: &Settings) -> Result<(), String> {
    if !is_supported_backup_path(&settings.backup_path) {
        return Err(
            "SETTINGS_INVALID: backupPath must be absolute or start with a supported tilde root"
                .into(),
        );
    }
    if !is_supported_backup_path(&settings.projects_dir) {
        return Err(
            "SETTINGS_INVALID: projectsDir must be absolute or start with a supported tilde root"
                .into(),
        );
    }
    if !(1..=90).contains(&settings.retention_days) {
        return Err("SETTINGS_INVALID: retentionDays must be between 1 and 90".into());
    }
    if !matches!(settings.theme.as_str(), "graphite" | "obsidian" | "nebula") {
        return Err("SETTINGS_INVALID: theme is not supported".into());
    }
    if !matches!(settings.density.as_str(), "comfortable" | "compact") {
        return Err("SETTINGS_INVALID: density is not supported".into());
    }
    if !(11..=18).contains(&settings.font_size) {
        return Err("SETTINGS_INVALID: fontSize must be between 11 and 18".into());
    }
    if settings.accent.len() != 7
        || !settings.accent.starts_with('#')
        || !settings.accent[1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("SETTINGS_INVALID: accent must be a six-digit hex color".into());
    }
    if settings
        .env_vars
        .iter()
        .any(|env| env.key.trim().is_empty())
    {
        // Environment values are deliberately omitted because they may contain secrets.
        return Err("SETTINGS_INVALID: environment variable keys cannot be empty".into());
    }
    Ok(())
}

fn is_supported_backup_path(path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }

    #[cfg(unix)]
    {
        path == "~" || path.starts_with("~/") || Path::new(path).is_absolute()
    }
    #[cfg(windows)]
    {
        is_windows_tilde_path(path) || Path::new(path).is_absolute()
    }
}

pub fn expand_tilde(path: &str) -> Result<PathBuf, String> {
    if is_native_tilde_path(path) {
        let home = dirs::home_dir()
            .ok_or_else(|| "PATH_EXPANSION_FAILED: home directory is unavailable".to_string())?;
        Ok(expand_tilde_with_home(path, &home))
    } else {
        Ok(PathBuf::from(path))
    }
}

fn is_native_tilde_path(path: &str) -> bool {
    #[cfg(unix)]
    {
        path == "~" || path.starts_with("~/")
    }
    #[cfg(windows)]
    {
        is_windows_tilde_path(path)
    }
}

#[cfg(any(windows, test))]
fn is_windows_tilde_path(path: &str) -> bool {
    path == "~" || path.starts_with("~\\") || path.starts_with("~/")
}

fn expand_tilde_with_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    #[cfg(unix)]
    let rest = path.strip_prefix("~/");
    #[cfg(windows)]
    let rest = path.strip_prefix("~\\").or_else(|| path.strip_prefix("~/"));
    if let Some(rest) = rest {
        return home.join(rest);
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::EnvVar;
    use tempfile::tempdir;

    #[test]
    fn missing_settings_file_loads_spec_defaults() {
        let root = tempdir().unwrap();
        let store = SettingsStore::new(root.path().join("config/settings.json"));

        let loaded = store.load().unwrap();

        assert_eq!(loaded, Settings::default());
        assert_eq!(loaded.backup_path, "~/.anchor/sessions");
        assert_eq!(loaded.retention_days, 30);
        assert_eq!(loaded.font_size, 13);
        assert_eq!(loaded.accent, "#d6417a");
        assert!(loaded.stop_on_close);
        assert!(!loaded.notify_on_waiting);
    }

    #[test]
    fn settings_round_trip_as_camel_case_json() {
        let root = tempdir().unwrap();
        let path = root.path().join("nested/settings.json");
        let store = SettingsStore::new(&path);
        let mut expected = Settings::default();
        expected.shell = "/synthetic/shell".into();
        expected.env_vars = vec![EnvVar {
            key: "SYNTHETIC_TOKEN".into(),
            value: "never-print-this-value".into(),
        }];
        expected.theme = "nebula".into();
        expected.density = "compact".into();

        store.save(&expected).unwrap();
        let raw = std::fs::read_to_string(path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(json["envVars"][0]["key"], "SYNTHETIC_TOKEN");
        assert_eq!(store.load().unwrap(), expected);
    }

    #[test]
    fn validation_accepts_boundaries_and_spec_options() {
        for retention_days in [1, 90] {
            for font_size in [11, 18] {
                for theme in ["graphite", "obsidian", "nebula"] {
                    for density in ["comfortable", "compact"] {
                        let mut settings = Settings::default();
                        settings.retention_days = retention_days;
                        settings.font_size = font_size;
                        settings.theme = theme.into();
                        settings.density = density.into();
                        settings.accent = "#A0b1C2".into();
                        assert!(validate(&settings).is_ok());
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn validation_accepts_only_unix_native_absolute_and_tilde_backup_paths() {
        for backup_path in ["/synthetic/anchor/sessions", "~", "~/.anchor/sessions"] {
            let mut settings = Settings::default();
            settings.backup_path = backup_path.into();

            assert!(
                validate(&settings).is_ok(),
                "supported backup path was rejected: {backup_path}"
            );
        }

        for backup_path in [
            r"C:\synthetic\anchor\sessions",
            r"\\server\share",
            r"~\.anchor",
        ] {
            let mut settings = Settings::default();
            settings.backup_path = backup_path.into();
            assert!(
                validate(&settings).is_err(),
                "foreign path was accepted: {backup_path}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn validation_accepts_only_windows_native_absolute_and_tilde_backup_paths() {
        for backup_path in [
            r"C:\synthetic\anchor\sessions",
            r"\\synthetic-server\anchor\sessions",
            "~",
            r"~\.anchor\sessions",
            "~/.anchor/sessions",
        ] {
            let mut settings = Settings::default();
            settings.backup_path = backup_path.into();
            assert!(
                validate(&settings).is_ok(),
                "native path was rejected: {backup_path}"
            );
        }

        for backup_path in ["/synthetic/anchor/sessions"] {
            let mut settings = Settings::default();
            settings.backup_path = backup_path.into();
            assert!(
                validate(&settings).is_err(),
                "foreign path was accepted: {backup_path}"
            );
        }

        let home = PathBuf::from(r"C:\synthetic-home");
        assert_eq!(
            expand_tilde_with_home("~/.anchor/sessions", &home),
            home.join(".anchor/sessions")
        );
    }

    #[test]
    fn windows_tilde_parser_accepts_spec_default_and_native_form() {
        assert!(is_windows_tilde_path("~/.anchor/sessions"));
        assert!(is_windows_tilde_path(r"~\.anchor\sessions"));
    }

    #[test]
    fn validation_rejects_empty_and_relative_backup_paths() {
        for backup_path in [
            "",
            "   ",
            "sessions",
            "./sessions",
            "../sessions",
            "~other/sessions",
        ] {
            let mut settings = Settings::default();
            settings.backup_path = backup_path.into();

            assert!(
                validate(&settings).is_err(),
                "invalid backup path was accepted: {backup_path}"
            );
        }
    }

    #[test]
    fn validation_rejects_out_of_range_and_invalid_choices() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Settings)>)> = vec![
            ("retention-low", Box::new(|s| s.retention_days = 0)),
            ("retention-high", Box::new(|s| s.retention_days = 91)),
            ("font-low", Box::new(|s| s.font_size = 10)),
            ("font-high", Box::new(|s| s.font_size = 19)),
            ("theme", Box::new(|s| s.theme = "light".into())),
            ("density", Box::new(|s| s.density = "spacious".into())),
            (
                "accent-missing-hash",
                Box::new(|s| s.accent = "d6417a".into()),
            ),
            ("accent-short", Box::new(|s| s.accent = "#fff".into())),
            ("accent-non-hex", Box::new(|s| s.accent = "#gggggg".into())),
        ];

        for (name, mutate) in cases {
            let mut settings = Settings::default();
            mutate(&mut settings);
            assert!(validate(&settings).is_err(), "case {name} was accepted");
        }
    }

    #[test]
    fn validation_rejects_blank_env_keys_without_leaking_values() {
        let mut settings = Settings::default();
        let secret = "synthetic-secret-value";
        settings.env_vars = vec![EnvVar {
            key: "   ".into(),
            value: secret.into(),
        }];

        let error = validate(&settings).unwrap_err();

        assert!(!error.contains(secret));
    }

    #[test]
    fn tilde_expansion_uses_injected_home_without_machine_specific_paths() {
        let root = tempdir().unwrap();
        let home = root.path().join("synthetic-home");

        assert_eq!(
            expand_tilde_with_home("~/.anchor/sessions", &home),
            home.join(".anchor/sessions")
        );
        assert_eq!(expand_tilde_with_home("~", &home), home);
        assert_eq!(
            expand_tilde_with_home("~another/place", &home),
            PathBuf::from("~another/place")
        );
    }
}
