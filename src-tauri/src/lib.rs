//! Anchor — Rust core. See docs/SPEC.md (§2 architecture, §6 IPC contract).

mod adapters;
mod backend;
mod commands;
mod models;
mod pty;
mod registry;
mod scrollback;
mod settings;
mod status;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use backend::{Backend, BackendEvents};
use models::{
    events, AttentionCountPayload, PtyOutputPayload, Session, SessionStatusPayload, Status,
};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

struct TauriEvents(tauri::AppHandle);

impl BackendEvents for TauriEvents {
    fn pty_output(&self, session_id: &str, data: &str) {
        let _ = self.0.emit(
            events::PTY_OUTPUT,
            PtyOutputPayload {
                session_id: session_id.to_owned(),
                data: data.to_owned(),
            },
        );
    }

    fn session_status(&self, session_id: &str, status: Status, exit_code: Option<i32>) {
        let _ = self.0.emit(
            events::SESSION_STATUS,
            SessionStatusPayload {
                session_id: session_id.to_owned(),
                status,
                exit_code,
            },
        );
    }

    fn session_updated(&self, session: &Session) {
        let _ = self.0.emit(events::SESSION_UPDATED, session);
    }

    fn attention_count(&self, waiting: u32, notify: bool) {
        let _ = self
            .0
            .emit(events::ATTENTION_COUNT, AttentionCountPayload { waiting });
        if let Some(window) = self.0.get_webview_window("main") {
            #[cfg(target_os = "windows")]
            {
                let AttentionSurface::OverlayIcon(show) = attention_surface(waiting, true) else {
                    unreachable!("Windows attention uses an overlay icon")
                };
                let icon = show
                    .then(|| self.0.default_window_icon().cloned())
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
                .0
                .notification()
                .builder()
                .title("Anchor")
                .body("A session needs your attention")
                .show();
        }
    }

    fn background_error(&self, message: &str) {
        // Background work has no command response. A safely JSON-encoded
        // `alert` provides a blocking in-app surface without expanding the
        // normative IPC contract; notification and window attention remain
        // redundant OS-level fallbacks.
        if let Some(window) = self.0.get_webview_window("main") {
            let _ = window.eval(blocking_alert_script(message));
            let _ = window.request_user_attention(Some(UserAttentionType::Critical));
        }
        let _ = self
            .0
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

fn blocking_alert_script(message: &str) -> String {
    // serde_json encoding prevents quotes, newlines, or attacker-controlled
    // text from escaping the JavaScript string literal.
    let encoded = serde_json::to_string(message)
        .unwrap_or_else(|_| "\"A background operation failed.\"".to_owned());
    format!("window.alert({encoded});")
}

#[derive(Default)]
struct PageLoadGate {
    finished: AtomicBool,
    action: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl PageLoadGate {
    fn install(&self, action: impl FnOnce() + Send + 'static) {
        let mut slot = self
            .action
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if self.finished.load(Ordering::Acquire) {
            drop(slot);
            action();
        } else {
            *slot = Some(Box::new(action));
        }
    }

    fn finish(&self) {
        if self.finished.swap(true, Ordering::AcqRel) {
            return;
        }
        let action = self
            .action
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(action) = action {
            action();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let page_load_gate = Arc::new(PageLoadGate::default());
    let page_load_callback = Arc::clone(&page_load_gate);
    let setup_gate = page_load_gate;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(move |webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                page_load_callback.finish();
            }
        })
        .setup(move |app| {
            let events: Arc<dyn BackendEvents> = Arc::new(TauriEvents(app.handle().clone()));
            let backend = Backend::platform(events).map_err(|error| {
                std::io::Error::other(format!("backend initialization failed: {error}"))
            })?;
            app.manage(backend.clone());
            setup_gate.install(move || backend.on_page_load_finished());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::create_folder,
            commands::create_project,
            commands::pick_folder,
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

#[cfg(test)]
mod tests {
    use super::{attention_surface, blocking_alert_script, AttentionSurface, PageLoadGate};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn background_alert_script_json_escapes_untrusted_text() {
        let script = blocking_alert_script("failure ' \" \n </script> ; window.evil()");
        assert!(script.starts_with("window.alert(\""));
        assert!(script.ends_with("\");"));
        assert!(script.contains("\\\""));
        assert!(script.contains("\\n"));
        assert!(!script.contains("; window.evil());"));
    }

    #[test]
    fn page_load_gate_runs_once_in_either_install_order() {
        for finish_first in [false, true] {
            let gate = PageLoadGate::default();
            let calls = Arc::new(AtomicUsize::new(0));
            if finish_first {
                gate.finish();
            }
            let captured = Arc::clone(&calls);
            gate.install(move || {
                captured.fetch_add(1, Ordering::AcqRel);
            });
            if !finish_first {
                gate.finish();
            }
            gate.finish();
            assert_eq!(calls.load(Ordering::Acquire), 1);
        }
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
