//! Anchor — Rust core. See docs/SPEC.md (§2 architecture, §6 IPC contract).

mod adapters;
mod commands;
mod models;
mod pty;
mod registry;
mod scrollback;
mod settings;
mod status;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::create_folder,
            commands::rename_folder,
            commands::remove_folder,
            commands::launch_session,
            commands::resume_session,
            commands::stop_session,
            commands::delete_session,
            commands::rename_session,
            commands::set_tab_open,
            commands::write_pty,
            commands::resize_pty,
            commands::get_scrollback,
            commands::get_settings,
            commands::set_settings,
            commands::detect_clis,
            commands::export_sessions,
            commands::import_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
