//! Thin Tauri command wrappers for the normative IPC contract (SPEC.md §6.2).

use std::sync::Arc;

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::backend::Backend;
use crate::models::*;

/// Run a lifecycle operation that can wait on a PTY off the native UI thread.
///
/// Synchronous Tauri commands run on the main thread, and stopping a PTY
/// deliberately waits out the graceful-termination window. Blocking there
/// freezes the window; the wait itself is correct and stays unchanged.
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "BACKGROUND_TASK_FAILED: lifecycle operation did not complete".to_string())?
}

#[tauri::command]
pub fn get_state(backend: State<'_, Arc<Backend>>) -> Result<AppState, String> {
    backend.get_state()
}

/// Frontend readiness handshake: sent once after the frontend has installed its
/// event listeners and hydrated, and the sole trigger for auto-restore.
#[tauri::command]
pub fn frontend_ready(backend: State<'_, Arc<Backend>>) {
    // The guard's return value only reports which call won the race; the
    // frontend has nothing to do with it either way.
    let _started = backend.inner().on_frontend_ready();
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

/// Open the OS folder picker (Finder on macOS) and return the chosen path, or
/// `None` if the user cancelled.
///
/// Async + `spawn_blocking`: sync Tauri commands run on the main thread, and
/// the native dialog must be driven from the main thread, so blocking there
/// would deadlock. Running the blocking call on a worker lets the plugin
/// dispatch to the main thread as designed.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| "DIALOG_FAILED: the folder picker did not return".to_string())?;

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "DIALOG_FAILED: the selected folder has no usable path".to_string())?;
    let path = path
        .to_str()
        .ok_or_else(|| "DIR_PATH_INVALID: folder path is not valid UTF-8".to_string())?
        .to_owned();
    Ok(Some(path))
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
pub async fn remove_folder(
    backend: State<'_, Arc<Backend>>,
    folder_id: String,
) -> Result<(), String> {
    let backend = Arc::clone(backend.inner());
    run_blocking(move || backend.remove_folder(&folder_id)).await
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
pub async fn stop_session(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
) -> Result<(), String> {
    let backend = Arc::clone(backend.inner());
    run_blocking(move || backend.stop_session(&session_id)).await
}

#[tauri::command]
pub async fn delete_session(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
) -> Result<(), String> {
    let backend = Arc::clone(backend.inner());
    run_blocking(move || backend.delete_session(&session_id)).await
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
pub async fn set_tab_open(
    backend: State<'_, Arc<Backend>>,
    session_id: String,
    open: bool,
) -> Result<(), String> {
    let backend = Arc::clone(backend.inner());
    run_blocking(move || backend.set_tab_open(&session_id, open)).await
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
