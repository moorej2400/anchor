//! Anchor — Rust core. See docs/SPEC.md (§2 architecture, §6 IPC contract).

mod adapters;
mod backend;
mod commands;
mod durable_file;
mod models;
mod pty;
mod registry;
mod scrollback;
mod settings;
mod status;
mod title_agent;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use backend::{Backend, BackendEvents};
use models::{
    events, AttentionCountPayload, PtyOutputPayload, Session, SessionResumeErrorPayload,
    SessionStatusPayload, Status,
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
struct BackgroundErrorGate(Mutex<HashSet<String>>);

impl BackgroundErrorGate {
    fn first_occurrence(&self, message: &str) -> bool {
        self.0
            .lock()
            .map(|mut surfaced| surfaced.insert(message.to_owned()))
            .unwrap_or(true)
    }
}

struct TauriEvents {
    app: tauri::AppHandle,
    background_errors: BackgroundErrorGate,
}

impl BackendEvents for TauriEvents {
    fn pty_output(
        &self,
        session_id: &str,
        data: &str,
        sequence: u64,
        grid_epoch: u64,
        cols: u16,
        rows: u16,
    ) {
        let _ = self.app.emit(
            events::PTY_OUTPUT,
            PtyOutputPayload {
                session_id: session_id.to_owned(),
                data: data.to_owned(),
                sequence,
                grid_epoch,
                cols,
                rows,
            },
        );
    }

    fn session_status(&self, session_id: &str, status: Status, exit_code: Option<i32>) {
        let _ = self.app.emit(
            events::SESSION_STATUS,
            SessionStatusPayload {
                session_id: session_id.to_owned(),
                status,
                exit_code,
            },
        );
    }

    fn session_updated(&self, session: &Session) {
        let _ = self.app.emit(events::SESSION_UPDATED, session);
    }

    fn session_resume_error(&self, session_id: &str, code: &str, message: &str) {
        let _ = self.app.emit(
            events::SESSION_RESUME_ERROR,
            SessionResumeErrorPayload {
                session_id: session_id.to_owned(),
                code: code.to_owned(),
                message: message.to_owned(),
            },
        );
    }

    fn attention_count(&self, waiting: u32, notify: bool) {
        let _ = self
            .app
            .emit(events::ATTENTION_COUNT, AttentionCountPayload { waiting });
        if let Some(window) = self.app.get_webview_window("main") {
            #[cfg(target_os = "windows")]
            {
                let AttentionSurface::OverlayIcon(show) = attention_surface(waiting, true) else {
                    unreachable!("Windows attention uses an overlay icon")
                };
                let icon = show
                    .then(|| self.app.default_window_icon().cloned())
                    .flatten();
                let _ = window.set_overlay_icon(icon);
            }
            #[cfg(not(target_os = "windows"))]
            {
                let AttentionSurface::Badge(count) = attention_surface(waiting, false) else {
                    unreachable!("non-Windows attention uses a badge count")
                };
                let _ = window.set_badge_count(count);
            }
        }
        if notify {
            let _ = self
                .app
                .notification()
                .builder()
                .title("Anchor")
                .body("A session needs your attention")
                .show();
        }
    }

    fn background_error(&self, message: &str) {
        // Status and discovery retries can report the same storage outage many
        // times. One OS notification is enough; taskbar attention is reserved
        // for completed AI responses and must never be driven by an error.
        if !self.background_errors.first_occurrence(message) {
            return;
        }
        let _ = self
            .app
            .notification()
            .builder()
            .title("Anchor background error")
            .body(message)
            .show();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttentionSurface {
    Badge(Option<i64>),
    OverlayIcon(bool),
}

fn attention_surface(waiting: u32, windows: bool) -> AttentionSurface {
    if windows {
        AttentionSurface::OverlayIcon(waiting > 0)
    } else {
        AttentionSurface::Badge((waiting > 0).then_some(i64::from(waiting)))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Auto-restore is not started here: page load says nothing about
        // whether the frontend has installed its event listeners. The frontend
        // calls `frontend_ready` once it has listeners, state, and a measured
        // terminal grid for initial PTY spawns (SPEC.md §8).
        .setup(move |app| {
            let events: Arc<dyn BackendEvents> = Arc::new(TauriEvents {
                app: app.handle().clone(),
                background_errors: BackgroundErrorGate::default(),
            });
            let backend = Backend::platform(events).map_err(|error| {
                std::io::Error::other(format!("backend initialization failed: {error}"))
            })?;
            app.manage(backend);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::frontend_ready,
            commands::create_folder,
            commands::create_project,
            commands::pick_folder,
            commands::rename_folder,
            commands::remove_folder,
            commands::launch_session,
            commands::launch_custom_session,
            commands::resume_session,
            commands::repair_session_identity,
            commands::fork_codex_session,
            commands::get_codex_profiles,
            commands::set_codex_profile,
            commands::stop_session,
            commands::delete_session,
            commands::rename_session,
            commands::set_session_id,
            commands::generate_session_title,
            commands::set_tab_open,
            commands::write_pty,
            commands::resize_pty,
            commands::replay_output,
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

#[cfg(test)]
mod tests {
    use super::{attention_surface, AttentionSurface, BackgroundErrorGate};

    #[test]
    fn background_errors_surface_each_message_once() {
        let gate = BackgroundErrorGate::default();
        assert!(gate.first_occurrence("REGISTRY_WRITE_FAILED"));
        assert!(!gate.first_occurrence("REGISTRY_WRITE_FAILED"));
        assert!(gate.first_occurrence("SCROLLBACK_WRITE_FAILED"));
    }

    #[test]
    fn attention_surface_uses_and_clears_windows_overlay_icon() {
        assert_eq!(
            attention_surface(3, true),
            AttentionSurface::OverlayIcon(true)
        );
        assert_eq!(
            attention_surface(0, true),
            AttentionSurface::OverlayIcon(false)
        );
        assert_eq!(
            attention_surface(3, false),
            AttentionSurface::Badge(Some(3))
        );
        assert_eq!(attention_surface(0, false), AttentionSurface::Badge(None));
    }
}
