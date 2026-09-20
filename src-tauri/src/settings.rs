//! Settings load/save (SPEC.md §3, §7). Phase 2 implements.
//! settings.json lives in the app config/data dir; env-var VALUES are user
//! secrets — they stay local, are masked in the UI, and must never appear in
//! logs, error messages, or committed files (public repo).

#![allow(dead_code)] // Used by later Phase 2 orchestration tasks.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::durable_file::{atomic_write, sha256_hex};
use crate::models::{Settings, Workspace, DEFAULT_WORKSPACE_ID};

const SETTINGS_RECOVERY_FORMAT_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsRecovery {
    format_version: u32,
    created_at: String,
    sha256: String,
    settings: Settings,
}

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
                return match self.load_recovery() {
                    Ok(Some(settings)) => self.finish_loaded_settings(settings, true),
                    Ok(None) => Ok(Settings::default()),
                    Err(_) => {
                        Err("SETTINGS_INVALID: settings recovery file is not valid".to_string())
                    }
                };
            }
            Err(_) => return Err("SETTINGS_READ_FAILED: could not read settings.json".into()),
        };
        match parse_settings(&bytes) {
            Ok(settings) => self.finish_loaded_settings(settings, false),
            Err(primary_error) => match self.load_recovery() {
                Ok(Some(settings)) => self.finish_loaded_settings(settings, true),
                Ok(None) | Err(_) => Err(primary_error),
            },
        }
    }

    pub fn save(&self, settings: &Settings) -> Result<(), String> {
        validate(settings)?;
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not serialize settings".to_string())?;
        atomic_write(&self.path, &bytes, "SETTINGS_WRITE_FAILED")?;
        // The primary settings are committed. Recovery maintenance is
        // best-effort so callers never roll memory back behind durable disk.
        let _ = self.write_recovery(settings);
        Ok(())
    }

    /// Private app data that must stay beside settings instead of moving with
    /// the user-selected session backup directory.
    pub(crate) fn internal_data_dir(&self) -> Result<PathBuf, String> {
        self.path
            .parent()
            .map(|parent| parent.join("internal"))
            .ok_or_else(|| "SETTINGS_PATH_INVALID: settings path has no parent".to_string())
    }

    fn recovery_path(&self) -> Result<PathBuf, String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "SETTINGS_PATH_INVALID: settings path has no parent".to_string())?;
        Ok(parent.join("settings.last-good.json"))
    }

    fn write_recovery(&self, settings: &Settings) -> Result<(), String> {
        let canonical = serde_json::to_vec(settings)
            .map_err(|_| "SETTINGS_BACKUP_FAILED: could not serialize settings".to_string())?;
        let envelope = SettingsRecovery {
            format_version: SETTINGS_RECOVERY_FORMAT_VERSION,
            created_at: Utc::now().to_rfc3339(),
            sha256: sha256_hex(&canonical),
            settings: settings.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&envelope)
            .map_err(|_| "SETTINGS_BACKUP_FAILED: could not serialize recovery file".to_string())?;
        atomic_write(&self.recovery_path()?, &bytes, "SETTINGS_BACKUP_FAILED")
    }

    fn load_recovery(&self) -> Result<Option<Settings>, String> {
        let path = self.recovery_path()?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err("SETTINGS_BACKUP_INVALID: could not read recovery file".to_string())
            }
        };
        let envelope: SettingsRecovery = serde_json::from_slice(&bytes)
            .map_err(|_| "SETTINGS_BACKUP_INVALID: recovery file is not valid JSON".to_string())?;
        if envelope.format_version != SETTINGS_RECOVERY_FORMAT_VERSION {
            return Err("SETTINGS_BACKUP_INVALID: recovery format is not supported".into());
        }
        let canonical = serde_json::to_vec(&envelope.settings)
            .map_err(|_| "SETTINGS_BACKUP_INVALID: could not verify recovery file".to_string())?;
        if sha256_hex(&canonical) != envelope.sha256 {
            return Err("SETTINGS_BACKUP_INVALID: recovery checksum does not match".into());
        }
        validate(&envelope.settings)?;
        Ok(Some(envelope.settings))
    }

    fn restore_primary(&self, settings: &Settings) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|_| "SETTINGS_WRITE_FAILED: could not serialize settings".to_string())?;
        atomic_write(&self.path, &bytes, "SETTINGS_WRITE_FAILED")
    }

    fn finish_loaded_settings(
        &self,
        mut settings: Settings,
        restore_primary: bool,
    ) -> Result<Settings, String> {
        let upgraded = upgrade_legacy_windows_default_shell(&mut settings)
            | upgrade_legacy_default_accent(&mut settings)
            | migrate_workspace_settings(&mut settings);
        if upgraded {
            self.save(&settings)?;
        } else if restore_primary {
            self.restore_primary(&settings)?;
        }
        Ok(settings)
    }
}

fn upgrade_legacy_default_accent(settings: &mut Settings) -> bool {
    if settings.accent.eq_ignore_ascii_case("#d6417a") {
        settings.accent = "#88a99d".into();
        return true;
    }
    false
}

fn migrate_workspace_settings(settings: &mut Settings) -> bool {
    let mut changed = false;
    if settings.workspaces.is_empty() {
        settings.workspaces.push(Workspace::default());
        changed = true;
    }
    if let Some(default) = settings
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == DEFAULT_WORKSPACE_ID)
    {
        if default.favorite_session_ids.is_empty() && !settings.favorite_session_ids.is_empty() {
            default.favorite_session_ids = settings.favorite_session_ids.clone();
            changed = true;
        }
        if default.folder_order.is_empty() && !settings.folder_order.is_empty() {
            default.folder_order = settings.folder_order.clone();
            changed = true;
        }
        if default.tab_order.is_empty() && !settings.tab_order.is_empty() {
            default.tab_order = settings.tab_order.clone();
            changed = true;
        }
    } else {
        let mut default = Workspace::default();
        default.favorite_session_ids = settings.favorite_session_ids.clone();
        default.folder_order = settings.folder_order.clone();
        default.tab_order = settings.tab_order.clone();
        settings.workspaces.insert(0, default);
        changed = true;
    }
    if !settings
        .workspaces
        .iter()
        .any(|workspace| workspace.id == settings.active_workspace_id && !workspace.archived)
    {
        settings.active_workspace_id = settings
            .workspaces
            .iter()
            .find(|workspace| !workspace.archived)
            .map(|workspace| workspace.id.clone())
            .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.into());
        changed = true;
    }
    changed
}

fn parse_settings(bytes: &[u8]) -> Result<Settings, String> {
    let settings: Settings = serde_json::from_slice(bytes)
        .map_err(|_| "SETTINGS_INVALID: settings.json is not valid JSON".to_string())?;
    validate(&settings)?;
    Ok(settings)
}

fn upgrade_legacy_windows_default_shell(settings: &mut Settings) -> bool {
    #[cfg(not(windows))]
    let _ = settings;
    #[cfg(windows)]
    {
        let preferred = crate::models::preferred_windows_shell();
        if matches!(
            settings.shell.to_ascii_lowercase().as_str(),
            "cmd" | "cmd.exe" | "powershell" | "powershell.exe"
        ) && settings.shell != preferred
        {
            // These were Anchor defaults, not a named PowerShell 7 choice.
            // Upgrade only when PowerShell 7 is available; otherwise retain
            // the built-in Windows PowerShell fallback.
            settings.shell = preferred;
            return true;
        }
    }
    false
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
    if !matches!(settings.response_read_delay_ms, 0 | 1_000 | 2_500 | 5_000) {
        return Err("SETTINGS_INVALID: responseReadDelayMs is not supported".into());
    }
    validate_ordered_ids(&settings.favorite_session_ids, "favoriteSessionIds")?;
    validate_ordered_ids(&settings.folder_order, "folderOrder")?;
    validate_ordered_ids(&settings.tab_order, "tabOrder")?;
    validate_empty_folder_times(&settings.empty_folder_since_ms)?;
    validate_workspaces(settings)?;
    validate_terminal_theme(settings)?;
    validate_harnesses(settings)?;
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

fn validate_workspaces(settings: &Settings) -> Result<(), String> {
    if settings.workspaces.is_empty() || settings.workspaces.len() > 512 {
        return Err("SETTINGS_INVALID: workspaces must contain 1 to 512 records".into());
    }
    let mut workspace_ids = HashSet::new();
    for workspace in &settings.workspaces {
        if uuid::Uuid::parse_str(&workspace.id).is_err()
            || !workspace_ids.insert(workspace.id.as_str())
            || workspace.name.trim().is_empty()
            || workspace.name.len() > 80
        {
            return Err("SETTINGS_INVALID: workspace identity or name is invalid".into());
        }
        validate_ordered_ids(
            &workspace.favorite_session_ids,
            "workspace.favoriteSessionIds",
        )?;
        validate_ordered_ids(&workspace.folder_order, "workspace.folderOrder")?;
        validate_ordered_ids(&workspace.tab_order, "workspace.tabOrder")?;
        validate_ordered_ids(
            &workspace.collapsed_folder_ids,
            "workspace.collapsedFolderIds",
        )?;
    }
    if !workspace_ids.contains(settings.active_workspace_id.as_str()) {
        return Err("SETTINGS_INVALID: activeWorkspaceId does not name a workspace".into());
    }
    if settings.session_workspace_ids.len() > 16_384
        || settings
            .session_workspace_ids
            .iter()
            .any(|(session_id, workspace_id)| {
                session_id.len() > 256
                    || uuid::Uuid::parse_str(session_id).is_err()
                    || !workspace_ids.contains(workspace_id.as_str())
            })
    {
        return Err("SETTINGS_INVALID: sessionWorkspaceIds is invalid".into());
    }
    Ok(())
}

fn validate_terminal_theme(settings: &Settings) -> Result<(), String> {
    let theme = &settings.terminal_theme;
    for color in [
        &theme.background,
        &theme.foreground,
        &theme.cursor,
        &theme.cursor_accent,
        &theme.selection_background,
        &theme.selection_foreground,
        &theme.black,
        &theme.red,
        &theme.green,
        &theme.yellow,
        &theme.blue,
        &theme.magenta,
        &theme.cyan,
        &theme.white,
        &theme.bright_black,
        &theme.bright_red,
        &theme.bright_green,
        &theme.bright_yellow,
        &theme.bright_blue,
        &theme.bright_magenta,
        &theme.bright_cyan,
        &theme.bright_white,
    ] {
        if !is_hex_color(color) {
            return Err("SETTINGS_INVALID: terminalTheme contains an invalid color".into());
        }
    }
    Ok(())
}

fn validate_harnesses(settings: &Settings) -> Result<(), String> {
    if settings.custom_harnesses.len() > 128 || settings.session_harness_ids.len() > 16_384 {
        return Err("SETTINGS_INVALID: custom harness limits were exceeded".into());
    }
    let mut ids = HashSet::new();
    for harness in &settings.custom_harnesses {
        let valid_id = !harness.id.is_empty()
            && harness.id.len() <= 64
            && harness
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        let valid_args = harness.launch_args.len() <= 64
            && harness.resume_args.len() <= 64
            && harness
                .launch_args
                .iter()
                .chain(&harness.resume_args)
                .all(|arg| {
                    arg.len() <= 4_096
                        && !arg.contains('\0')
                        && has_only_supported_harness_placeholders(arg)
                });
        let launch_uses_session_id = harness
            .launch_args
            .iter()
            .any(|arg| arg.contains("{sessionId}"));
        let any_session_id_placeholder = launch_uses_session_id
            || harness
                .resume_args
                .iter()
                .any(|arg| arg.contains("{sessionId}"));
        if !valid_id
            || !ids.insert(harness.id.as_str())
            || harness.name.trim().is_empty()
            || harness.name.len() > 80
            || harness.executable.trim().is_empty()
            || harness.executable.len() > 1_024
            || harness.executable.contains('\0')
            || !valid_args
            || !matches!(
                harness.session_id_strategy.as_str(),
                "none" | "preassigned" | "manual"
            )
            || (harness.session_id_strategy == "preassigned" && !launch_uses_session_id)
            || (harness.session_id_strategy == "none" && any_session_id_placeholder)
            || harness.working_directory != "project"
            || (!harness.data_directory.trim().is_empty()
                && !is_supported_backup_path(&harness.data_directory))
            || !matches!(harness.kind.as_str(), "ai" | "terminal")
        {
            return Err("SETTINGS_INVALID: custom harness definition is invalid".into());
        }
    }
    if settings
        .session_harness_ids
        .iter()
        .any(|(session_id, harness_id)| {
            uuid::Uuid::parse_str(session_id).is_err() || !ids.contains(harness_id.as_str())
        })
    {
        return Err("SETTINGS_INVALID: sessionHarnessIds is invalid".into());
    }
    Ok(())
}

fn has_only_supported_harness_placeholders(argument: &str) -> bool {
    let without_known = argument
        .replace("{projectPath}", "")
        .replace("{sessionId}", "")
        .replace("{dataDirectory}", "");
    !without_known.contains('{') && !without_known.contains('}')
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_ordered_ids(ids: &[String], field: &str) -> Result<(), String> {
    if ids.len() > 4_096
        || ids.iter().any(|id| id.is_empty() || id.len() > 256)
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        // Values are not echoed because imported identifiers can be private.
        return Err(format!(
            "SETTINGS_INVALID: {field} is not a valid ordered id list"
        ));
    }
    Ok(())
}

fn validate_empty_folder_times(
    values: &std::collections::BTreeMap<String, u64>,
) -> Result<(), String> {
    const MAX_JS_DATE_MS: u64 = 8_640_000_000_000_000;
    if values.len() > 4_096
        || values
            .iter()
            .any(|(id, timestamp)| id.is_empty() || id.len() > 256 || *timestamp > MAX_JS_DATE_MS)
    {
        // Folder identifiers can be private, so validation errors name only the field.
        return Err(
            "SETTINGS_INVALID: emptyFolderSinceMs is not a valid folder timestamp map".into(),
        );
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
    use crate::models::{EnvVar, HarnessDefinition};
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
        assert_eq!(loaded.accent, "#88a99d");
        assert!(loaded.stop_on_close);
        assert!(!loaded.notify_on_waiting);
        assert_eq!(loaded.response_read_delay_ms, 1_000);
        assert!(loaded.favorite_session_ids.is_empty());
        assert!(loaded.folder_order.is_empty());
        assert!(loaded.empty_folder_since_ms.is_empty());
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
        expected.response_read_delay_ms = 2_500;
        expected.favorite_session_ids = vec!["synthetic-session".into()];
        expected.folder_order = vec!["synthetic-folder-b".into(), "synthetic-folder-a".into()];
        expected.tab_order = vec!["synthetic-tab-b".into(), "synthetic-tab-a".into()];
        expected.workspaces[0].favorite_session_ids = expected.favorite_session_ids.clone();
        expected.workspaces[0].folder_order = expected.folder_order.clone();
        expected.workspaces[0].tab_order = expected.tab_order.clone();
        expected
            .empty_folder_since_ms
            .insert("synthetic-empty-folder".into(), 1_767_268_800_000);

        store.save(&expected).unwrap();
        let raw = std::fs::read_to_string(path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(json["envVars"][0]["key"], "SYNTHETIC_TOKEN");
        assert_eq!(json["responseReadDelayMs"], 2_500);
        assert_eq!(json["favoriteSessionIds"][0], "synthetic-session");
        assert_eq!(json["tabOrder"][0], "synthetic-tab-b");
        assert_eq!(
            json["emptyFolderSinceMs"]["synthetic-empty-folder"],
            1_767_268_800_000_u64
        );
        assert_eq!(store.load().unwrap(), expected);
    }

    #[test]
    fn legacy_sidebar_state_migrates_into_the_default_workspace() {
        let root = tempdir().unwrap();
        let path = root.path().join("config/settings.json");
        let store = SettingsStore::new(&path);
        let mut json = serde_json::to_value(Settings::default()).unwrap();
        let object = json.as_object_mut().unwrap();
        object.remove("workspaces");
        object.remove("activeWorkspaceId");
        object.insert("accent".into(), serde_json::json!("#d6417a"));
        object.insert(
            "favoriteSessionIds".into(),
            serde_json::json!(["synthetic-session"]),
        );
        object.insert(
            "folderOrder".into(),
            serde_json::json!(["synthetic-folder"]),
        );
        object.insert("tabOrder".into(), serde_json::json!(["synthetic-tab"]));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&json).unwrap()).unwrap();

        let loaded = store.load().unwrap();
        let default = loaded
            .workspaces
            .iter()
            .find(|workspace| workspace.id == DEFAULT_WORKSPACE_ID)
            .unwrap();

        assert_eq!(loaded.accent, "#88a99d");
        assert_eq!(loaded.active_workspace_id, DEFAULT_WORKSPACE_ID);
        assert_eq!(
            default.favorite_session_ids,
            vec!["synthetic-session".to_string()]
        );
        assert_eq!(default.folder_order, vec!["synthetic-folder".to_string()]);
        assert_eq!(default.tab_order, vec!["synthetic-tab".to_string()]);
    }

    #[test]
    fn validation_accepts_a_safe_custom_harness_definition() {
        let mut settings = Settings::default();
        settings.custom_harnesses.push(HarnessDefinition {
            id: "synthetic-agent".into(),
            name: "Synthetic agent".into(),
            executable: "synthetic-agent".into(),
            launch_args: vec!["--cwd".into(), "{projectPath}".into()],
            resume_args: vec!["resume".into(), "{sessionId}".into()],
            session_id_strategy: "manual".into(),
            working_directory: "project".into(),
            data_directory: "~/.anchor/harnesses/synthetic-agent".into(),
            kind: "ai".into(),
            enabled: true,
        });

        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn validation_rejects_invalid_terminal_colors_and_shell_like_harness_ids() {
        let mut invalid_color = Settings::default();
        invalid_color.terminal_theme.background = "black".into();
        assert!(validate(&invalid_color).is_err());

        let mut invalid_harness = Settings::default();
        invalid_harness.custom_harnesses.push(HarnessDefinition {
            id: "agent; command".into(),
            name: "Synthetic agent".into(),
            executable: "synthetic-agent".into(),
            launch_args: Vec::new(),
            resume_args: Vec::new(),
            session_id_strategy: "none".into(),
            working_directory: "project".into(),
            data_directory: String::new(),
            kind: "terminal".into(),
            enabled: true,
        });
        assert!(validate(&invalid_harness).is_err());

        let valid = HarnessDefinition {
            id: "synthetic-agent".into(),
            name: "Synthetic agent".into(),
            executable: "synthetic-agent".into(),
            launch_args: vec!["--cwd".into(), "{projectPath}".into()],
            resume_args: vec!["resume".into(), "{sessionId}".into()],
            session_id_strategy: "manual".into(),
            working_directory: "project".into(),
            data_directory: String::new(),
            kind: "ai".into(),
            enabled: true,
        };

        let mut invalid_preassigned = Settings::default();
        invalid_preassigned
            .custom_harnesses
            .push(HarnessDefinition {
                session_id_strategy: "preassigned".into(),
                ..valid.clone()
            });
        assert!(validate(&invalid_preassigned).is_err());

        let mut invalid_none = Settings::default();
        invalid_none.custom_harnesses.push(HarnessDefinition {
            session_id_strategy: "none".into(),
            ..valid.clone()
        });
        assert!(validate(&invalid_none).is_err());

        let mut invalid_placeholder = Settings::default();
        invalid_placeholder
            .custom_harnesses
            .push(HarnessDefinition {
                launch_args: vec!["{unknown}".into()],
                ..valid.clone()
            });
        assert!(validate(&invalid_placeholder).is_err());

        let mut invalid_data_directory = Settings::default();
        invalid_data_directory
            .custom_harnesses
            .push(HarnessDefinition {
                data_directory: "relative/data".into(),
                ..valid
            });
        assert!(validate(&invalid_data_directory).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn load_upgrades_only_legacy_windows_default_shells() {
        let root = tempdir().unwrap();
        let store = SettingsStore::new(root.path().join("config/settings.json"));
        let preferred = crate::models::preferred_windows_shell();
        assert_eq!(Settings::default().shell, preferred);
        let mut legacy = Settings::default();
        legacy.shell = "cmd.exe".into();
        store.save(&legacy).unwrap();

        assert_eq!(store.load().unwrap().shell, preferred);

        let mut selected = Settings::default();
        selected.shell = "C:\\Synthetic\\custom-shell.exe".into();
        store.save(&selected).unwrap();

        assert_eq!(store.load().unwrap().shell, selected.shell);
    }

    #[test]
    fn corrupt_settings_primary_recovers_the_exact_registry_location() {
        let root = tempdir().unwrap();
        let path = root.path().join("config/settings.json");
        let store = SettingsStore::new(&path);
        let mut expected = Settings::default();
        expected.backup_path = if cfg!(windows) {
            r"C:\synthetic\anchor-sessions".into()
        } else {
            "/synthetic/anchor-sessions".into()
        };
        store.save(&expected).unwrap();
        fs::write(&path, b"{broken").unwrap();

        let recovered = store.load().unwrap();

        assert_eq!(recovered.backup_path, expected.backup_path);
        assert_eq!(
            serde_json::from_slice::<Settings>(&fs::read(path).unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn missing_settings_primary_recovers_from_last_good() {
        let root = tempdir().unwrap();
        let path = root.path().join("config/settings.json");
        let store = SettingsStore::new(&path);
        let mut expected = Settings::default();
        expected.projects_dir = if cfg!(windows) {
            r"C:\synthetic\projects".into()
        } else {
            "/synthetic/projects".into()
        };
        store.save(&expected).unwrap();
        fs::rename(&path, root.path().join("settings.missing-source.json")).unwrap();

        let recovered = store.load().unwrap();

        assert_eq!(recovered, expected);
        assert!(path.is_file());
    }

    #[test]
    fn invalid_settings_and_invalid_recovery_fail_without_using_defaults() {
        let root = tempdir().unwrap();
        let path = root.path().join("config/settings.json");
        let store = SettingsStore::new(&path);
        store.save(&Settings::default()).unwrap();
        fs::write(&path, b"{broken-primary").unwrap();
        let recovery_path = root.path().join("config/settings.last-good.json");
        let mut recovery: serde_json::Value =
            serde_json::from_slice(&fs::read(&recovery_path).unwrap()).unwrap();
        recovery["sha256"] = serde_json::Value::String("0".repeat(64));
        fs::write(
            &recovery_path,
            serde_json::to_vec_pretty(&recovery).unwrap(),
        )
        .unwrap();

        let error = store.load().unwrap_err();

        assert!(error.starts_with("SETTINGS_INVALID:"));
        assert_eq!(fs::read(path).unwrap(), b"{broken-primary");
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
            (
                "read-delay",
                Box::new(|s| s.response_read_delay_ms = 10_000),
            ),
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
    fn validation_rejects_duplicate_or_unbounded_sidebar_ids() {
        let mut duplicate = Settings::default();
        duplicate.favorite_session_ids = vec!["synthetic-id".into(), "synthetic-id".into()];
        assert!(validate(&duplicate).is_err());

        let mut too_long = Settings::default();
        too_long.folder_order = vec!["x".repeat(257)];
        assert!(validate(&too_long).is_err());

        let mut invalid_empty_time = Settings::default();
        invalid_empty_time
            .empty_folder_since_ms
            .insert("synthetic-folder".into(), 8_640_000_000_000_001);
        assert!(validate(&invalid_empty_time).is_err());
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
