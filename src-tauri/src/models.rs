//! Shared IPC/data types. Normative source: docs/SPEC.md §6 — mirrors
//! src/ipc/types.ts. Do not change without updating SPEC.md in the same commit.

// Phase 1 skeleton: several contract items (event names/payloads) are defined
// ahead of their Phase 2 call sites.
#![allow(dead_code)]

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
    pub theme: String,   // "graphite" | "obsidian" | "nebula"
    pub density: String, // "comfortable" | "compact"
    pub font_size: u32,
    pub accent: String,
    pub notify_on_waiting: bool,
}

/// Serde default so settings.json files written before this field existed
/// still load instead of failing validation.
pub fn default_projects_dir() -> String {
    "~/Documents/Anchor/Projects".into()
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
            theme: "graphite".into(),
            density: "comfortable".into(),
            font_size: 13,
            accent: "#d6417a".into(),
            notify_on_waiting: false,
        }
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".into()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
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
    pub const ATTENTION_COUNT: &str = "attention:count";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub session_id: String,
    pub data: String,
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
pub struct AttentionCountPayload {
    pub waiting: u32,
}
