//! Thin Tauri command wrappers for the normative IPC contract (SPEC.md §6.2).

use std::sync::Arc;

use tauri::State;

use crate::backend::Backend;
use crate::models::*;

#[tauri::command]
pub fn get_state(backend: State<'_, Arc<Backend>>) -> Result<AppState, String> {
    backend.get_state()
}

#[tauri::command]
pub fn create_folder(
    backend: State<'_, Arc<Backend>>,
    path: String,
    name: Option<String>,
) -> Result<Folder, String> {
    backend.create_folder(path, name)
}

#[tauri::command]
pub fn create_project(backend: State<'_, Arc<Backend>>, name: String) -> Result<Folder, String> {
    backend.create_project(name)
}

#[tauri::command]
pub fn list_dir(
    backend: State<'_, Arc<Backend>>,
    path: Option<String>,
) -> Result<DirListing, String> {
    backend.list_dir(path)
}

#[tauri::command]
pub fn rename_folder(
    backend: State<'_, Arc<Backend>>,
    folder_id: String,
    name: String,
) -> Result<Folder, String> {
    backend.rename_folder(&folder_id, name)
}

#[tauri::command]
pub fn remove_folder(backend: State<'_, Arc<Backend>>, folder_id: String) -> Result<(), String> {
    backend.remove_folder(&folder_id)
}

#[tauri::command]
pub fn launch_session(
    backend: State<'_, Arc<Backend>>,
    folder_id: String,
    tool: Tool,
    title: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<Session, String> {
    backend
        .inner()
        .launch_session(&folder_id, tool, title, extra_args)
}

#[tauri::command]
pub fn resume_session(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
) -> Result<Session, String> {
    backend.inner().resume_session(&session_id)
}

#[tauri::command]
pub fn stop_session(backend: State<'_, Arc<Backend>>, session_id: String) -> Result<(), String> {
    backend.stop_session(&session_id)
}

#[tauri::command]
pub fn delete_session(backend: State<'_, Arc<Backend>>, session_id: String) -> Result<(), String> {
    backend.delete_session(&session_id)
}

#[tauri::command]
pub fn rename_session(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
    title: String,
) -> Result<Session, String> {
    backend.rename_session(&session_id, title)
}

#[tauri::command]
pub fn set_tab_open(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
    open: bool,
) -> Result<(), String> {
    backend.set_tab_open(&session_id, open)
}

#[tauri::command]
pub fn write_pty(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    backend.write_pty(&session_id, data)
}

#[tauri::command]
pub fn resize_pty(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    backend.resize_pty(&session_id, cols, rows)
}

#[tauri::command]
pub fn get_scrollback(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
) -> Result<String, String> {
    backend.get_scrollback(&session_id)
}

#[tauri::command]
pub fn get_settings(backend: State<'_, Arc<Backend>>) -> Result<Settings, String> {
    backend.get_settings()
}

#[tauri::command]
pub fn set_settings(
    backend: State<'_, Arc<Backend>>,
    settings: Settings,
) -> Result<Settings, String> {
    backend.set_settings(settings)
}

#[tauri::command]
pub fn detect_clis(backend: State<'_, Arc<Backend>>) -> Result<Vec<CliInfo>, String> {
    backend.detect_clis()
}

#[tauri::command]
pub fn export_sessions(backend: State<'_, Arc<Backend>>, to_path: String) -> Result<(), String> {
    backend.export_sessions(&to_path)
}

#[tauri::command]
pub fn import_sessions(
    backend: State<'_, Arc<Backend>>,
    from_path: String,
) -> Result<AppState, String> {
    backend.import_sessions(&from_path)
}
