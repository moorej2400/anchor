//! Shared IPC/data types. Normative source: docs/SPEC.md §6 — mirrors
//! src/ipc/types.ts. Do not change without updating SPEC.md in the same commit.

// Phase 1 skeleton: several contract items (event names/payloads) are defined
// ahead of their Phase 2 call sites.
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Claude,
    Codex,
    Copilot,
    Opencode,
    Terminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Waiting,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub folder_id: String,
    pub tool: Tool,
    pub title: String,
    pub cli_session_id: Option<String>,
    pub status: Status,
    pub model: Option<String>,
    pub extra_args: Vec<String>,
    /// The optional Codex config layer used for every future launch of this record.
    /// Other tools always leave this unset.
    #[serde(default)]
    pub codex_profile: Option<String>,
    pub created_at: String,
    pub last_active_at: String,
    pub was_open_in_tab: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

pub const DEFAULT_WORKSPACE_ID: &str = "00000000-0000-4000-8000-000000000001";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pinned: bool,
    pub archived: bool,
    #[serde(default)]
    pub favorite_session_ids: Vec<String>,
    #[serde(default)]
    pub folder_order: Vec<String>,
    #[serde(default)]
    pub tab_order: Vec<String>,
    #[serde(default)]
    pub collapsed_folder_ids: Vec<String>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            id: DEFAULT_WORKSPACE_ID.into(),
            name: "Default".into(),
            pinned: true,
            archived: false,
            favorite_session_ids: Vec::new(),
            folder_order: Vec::new(),
            tab_order: Vec::new(),
            collapsed_folder_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTheme {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub selection_foreground: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

impl Default for TerminalTheme {
    fn default() -> Self {
        Self {
            background: "#0c0e0d".into(),
            foreground: "#cbd0ce".into(),
            cursor: "#88a99d".into(),
            cursor_accent: "#0c0e0d".into(),
            selection_background: "#34413c".into(),
            selection_foreground: "#eef2f0".into(),
            black: "#151817".into(),
            red: "#cf7373".into(),
            green: "#92bd94".into(),
            yellow: "#d0b57a".into(),
            blue: "#78a9d1".into(),
            magenta: "#aea1c5".into(),
            cyan: "#77b2ba".into(),
            white: "#cbd0ce".into(),
            bright_black: "#68716d".into(),
            bright_red: "#e38a8a".into(),
            bright_green: "#add3ae".into(),
            bright_yellow: "#e3ca91".into(),
            bright_blue: "#94bee0".into(),
            bright_magenta: "#c5b5dc".into(),
            bright_cyan: "#91c8ce".into(),
            bright_white: "#eef2f0".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDefinition {
    pub id: String,
    pub name: String,
    pub executable: String,
    #[serde(default)]
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub resume_args: Vec<String>,
    pub session_id_strategy: String,
    pub working_directory: String,
    #[serde(default)]
    pub data_directory: String,
    pub kind: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub shell: String,
    pub env_vars: Vec<EnvVar>,
    pub auto_restore: bool,
    pub confirm_close: bool,
    pub stop_on_close: bool,
    pub restore_scrollback: bool,
    pub backup_path: String,
    /// Where "Create a new project" makes folders (SPEC.md §7).
    #[serde(default = "default_projects_dir")]
    pub projects_dir: String,
    pub retention_days: u32,
    /// Maximum logical lines retained for each generic terminal scrollback.
    /// Older settings files did not have this cap, so absent values use the
    /// conservative default when they are loaded.
    #[serde(default = "default_scrollback_line_limit")]
    pub scrollback_line_limit: u32,
    pub theme: String,   // "graphite" | "obsidian" | "nebula"
    pub density: String, // "comfortable" | "compact"
    pub font_size: u32,
    pub accent: String,
    pub notify_on_waiting: bool,
    #[serde(default = "default_response_read_delay_ms")]
    pub response_read_delay_ms: u32,
    #[serde(default)]
    pub favorite_session_ids: Vec<String>,
    #[serde(default)]
    pub folder_order: Vec<String>,
    #[serde(default)]
    pub tab_order: Vec<String>,
    /// Stable key order keeps settings and their recovery checksum deterministic.
    #[serde(default)]
    pub empty_folder_since_ms: BTreeMap<String, u64>,
    #[serde(default = "default_workspaces")]
    pub workspaces: Vec<Workspace>,
    #[serde(default = "default_active_workspace_id")]
    pub active_workspace_id: String,
    #[serde(default)]
    pub session_workspace_ids: BTreeMap<String, String>,
    #[serde(default)]
    pub workspace_pane_keep_open: bool,
    #[serde(default)]
    pub terminal_theme: TerminalTheme,
    #[serde(default)]
    pub custom_harnesses: Vec<HarnessDefinition>,
    #[serde(default)]
    pub session_harness_ids: BTreeMap<String, String>,
}

/// Serde default so settings.json files written before this field existed
/// still load instead of failing validation.
pub fn default_projects_dir() -> String {
    "~/Documents/Anchor/Projects".into()
}

pub fn default_response_read_delay_ms() -> u32 {
    1_000
}

pub fn default_scrollback_line_limit() -> u32 {
    10_000
}

pub fn default_workspaces() -> Vec<Workspace> {
    vec![Workspace::default()]
}

pub fn default_active_workspace_id() -> String {
    DEFAULT_WORKSPACE_ID.into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shell: default_shell(),
            env_vars: Vec::new(),
            auto_restore: true,
            confirm_close: true,
            stop_on_close: true,
            restore_scrollback: true,
            backup_path: "~/.anchor/sessions".into(),
            projects_dir: default_projects_dir(),
            retention_days: 30,
            scrollback_line_limit: default_scrollback_line_limit(),
            theme: "graphite".into(),
            density: "comfortable".into(),
            font_size: 13,
            accent: "#88a99d".into(),
            notify_on_waiting: false,
            response_read_delay_ms: default_response_read_delay_ms(),
            favorite_session_ids: Vec::new(),
            folder_order: Vec::new(),
            tab_order: Vec::new(),
            empty_folder_since_ms: BTreeMap::new(),
            workspaces: default_workspaces(),
            active_workspace_id: default_active_workspace_id(),
            session_workspace_ids: BTreeMap::new(),
            workspace_pane_keep_open: false,
            terminal_theme: TerminalTheme::default(),
            custom_harnesses: Vec::new(),
            session_harness_ids: BTreeMap::new(),
        }
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        preferred_windows_shell()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[cfg(windows)]
pub(crate) fn preferred_windows_shell() -> String {
    // PowerShell 7 carries the user's current profile and environment, but it
    // is optional on Windows; keep the built-in host as the safe fallback.
    let pwsh_available =
        std::env::var_os("PATH").is_some_and(|path| executable_exists_in_path("pwsh.exe", &path));
    if pwsh_available {
        "pwsh.exe".into()
    } else {
        "powershell.exe".into()
    }
}

#[cfg(windows)]
fn executable_exists_in_path(executable: &str, path: &std::ffi::OsStr) -> bool {
    std::env::split_paths(path).any(|directory| directory.join(executable).is_file())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub tool: Tool,
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
}

/// Event names (SPEC.md §6.3).
pub mod events {
    pub const PTY_OUTPUT: &str = "pty:output";
    pub const SESSION_STATUS: &str = "session:status";
    pub const SESSION_UPDATED: &str = "session:updated";
    pub const SESSION_RESUME_ERROR: &str = "session:resume-error";
    pub const ATTENTION_COUNT: &str = "attention:count";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub session_id: String,
    pub data: String,
    pub sequence: u64,
    pub grid_epoch: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyReplay {
    pub data: String,
    pub through_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub covers_unsequenced: bool,
    pub grid_epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResize {
    /// Last output sequence produced before the PTY accepted this grid.
    pub through_sequence: u64,
    pub grid_epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusPayload {
    pub session_id: String,
    pub status: Status,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeErrorPayload {
    pub session_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCountPayload {
    pub waiting: u32,
}
