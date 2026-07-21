//! #[tauri::command] handlers — thin wrappers that delegate to the modules.
//! Contract: docs/SPEC.md §6.2. Phase 2 implements the bodies.
//!
//! Errors are strings of the form "CODE: message" (e.g. "CLI_NOT_FOUND: …").

use crate::models::*;

const PHASE2: &str = "NOT_IMPLEMENTED: Phase 2 (backend) has not been implemented yet";

#[tauri::command]
pub fn get_state() -> Result<AppState, String> {
    // Phase 1: empty state so the placeholder UI can verify IPC round-trips.
    Ok(AppState {
        folders: Vec::new(),
        sessions: Vec::new(),
    })
}

#[tauri::command]
pub fn create_folder(path: String, name: Option<String>) -> Result<Folder, String> {
    let _ = (path, name);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn rename_folder(folder_id: String, name: String) -> Result<Folder, String> {
    let _ = (folder_id, name);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn remove_folder(folder_id: String) -> Result<(), String> {
    let _ = folder_id;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn launch_session(
    folder_id: String,
    tool: Tool,
    title: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<Session, String> {
    let _ = (folder_id, tool, title, extra_args);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn resume_session(session_id: String) -> Result<Session, String> {
    let _ = session_id;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn stop_session(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn delete_session(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn rename_session(session_id: String, title: String) -> Result<Session, String> {
    let _ = (session_id, title);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn set_tab_open(session_id: String, open: bool) -> Result<(), String> {
    let _ = (session_id, open);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn write_pty(session_id: String, data: String) -> Result<(), String> {
    let _ = (session_id, data);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn resize_pty(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let _ = (session_id, cols, rows);
    Err(PHASE2.into())
}

#[tauri::command]
pub fn get_scrollback(session_id: String) -> Result<String, String> {
    let _ = session_id;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    Ok(Settings::default())
}

#[tauri::command]
pub fn set_settings(settings: Settings) -> Result<Settings, String> {
    let _ = settings;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn detect_clis() -> Result<Vec<CliInfo>, String> {
    Err(PHASE2.into())
}

#[tauri::command]
pub fn export_sessions(to_path: String) -> Result<(), String> {
    let _ = to_path;
    Err(PHASE2.into())
}

#[tauri::command]
pub fn import_sessions(from_path: String) -> Result<AppState, String> {
    let _ = from_path;
    Err(PHASE2.into())
}
