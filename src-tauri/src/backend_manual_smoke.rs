//! Opt-in acceptance coverage for the real Claude Code executable.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tempfile::tempdir;

#[derive(Default)]
struct ClaudeSmokeEvents {
    registry_path: Mutex<PathBuf>,
    output: Mutex<String>,
    first_output_saw_persisted_identity: AtomicBool,
    first_output_checked: AtomicBool,
}

impl BackendEvents for ClaudeSmokeEvents {
    fn pty_output(&self, _session_id: &str, data: &str) {
        if !self.first_output_checked.swap(true, Ordering::AcqRel) {
            let path = self.registry_path.lock().unwrap().clone();
            let persisted = fs::read_to_string(path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|json| json["sessions"].as_array().cloned())
                .is_some_and(|sessions| {
                    sessions.len() == 1 && !sessions[0]["cliSessionId"].is_null()
                });
            self.first_output_saw_persisted_identity
                .store(persisted, Ordering::Release);
        }
        let mut output = self.output.lock().unwrap();
        if output.len() < 1_000_000 {
            output.push_str(data);
        }
    }
}

fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    predicate()
}

#[test]
#[ignore = "requires an installed/authenticated Claude CLI and makes one capped API request"]
fn real_claude_launch_persists_identity_before_output_and_resumes() {
    assert!(
        find_executable_with_environment(
            "claude",
            std::env::var_os("PATH").as_deref(),
            dirs::home_dir().as_deref(),
        )
        .is_some(),
        "claude is not installed"
    );
    let root = tempdir().unwrap();
    let backup = root.path().join("backup");
    let project = root.path().join("trusted-project");
    fs::create_dir(&project).unwrap();
    let mut settings = Settings::default();
    settings.backup_path = backup.to_string_lossy().into_owned();
    let store = SettingsStore::new(root.path().join("config/settings.json"));
    store.save(&settings).unwrap();
    let events = Arc::new(ClaudeSmokeEvents {
        registry_path: Mutex::new(backup.join("registry.json")),
        ..ClaudeSmokeEvents::default()
    });
    let backend = Backend::for_test_real(store, settings, Registry::empty(&backup), events.clone());
    let folder = backend
        .create_folder(project.to_string_lossy().into_owned(), None)
        .unwrap();
    let marker = "ANCHOR_PHASE2_CLAUDE_SMOKE_7D31";
    // The opt-in provider call disables project customizations and tools, and
    // caps spend so acceptance cannot mutate the checkout or run unbounded.
    let launched = backend
        .launch_session(
            &folder.id,
            Tool::Claude,
            Some("Claude acceptance smoke".into()),
            Some(vec![
                "--safe-mode".into(),
                "--tools".into(),
                "".into(),
                "--max-budget-usd".into(),
                "0.05".into(),
                "-p".into(),
                format!("Reply with exactly {marker}"),
            ]),
        )
        .unwrap();
    let cli_session_id = launched.cli_session_id.clone().unwrap();
    assert!(wait_until(Duration::from_secs(180), || {
        backend.session(&launched.id).unwrap().status == Status::Stopped
    }));
    assert!(events
        .first_output_saw_persisted_identity
        .load(Ordering::Acquire));
    let launch_output = events.output.lock().unwrap().clone();
    assert!(
        launch_output.contains(marker),
        "Claude did not complete the capped smoke prompt; verify `claude auth status`"
    );
    let persisted = Registry::load_from_backup_path(&backup).unwrap();
    assert_eq!(
        persisted.sessions[0].cli_session_id.as_deref(),
        Some(cli_session_id.as_str())
    );

    events.output.lock().unwrap().clear();
    let resumed = backend.resume_session(&launched.id).unwrap();
    assert_eq!(
        resumed.cli_session_id.as_deref(),
        Some(cli_session_id.as_str())
    );
    assert!(wait_until(Duration::from_secs(30), || {
        backend.runtime.is_live(&launched.id) && events.output.lock().unwrap().contains(marker)
    }));
    backend.write_pty(&launched.id, "/exit\r".into()).unwrap();
    if !wait_until(Duration::from_secs(15), || {
        !backend.runtime.is_live(&launched.id)
    }) {
        backend.stop_session(&launched.id).unwrap();
    }
}
