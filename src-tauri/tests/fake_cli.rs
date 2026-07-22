#![cfg(unix)]

#[path = "../src/adapters/mod.rs"]
mod adapters;
#[path = "../src/models.rs"]
mod models;

use std::fs;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use adapters::codex::CodexAdapter;
use adapters::{Adapter, SpawnSpec};
use models::{Session, Settings, Status, Tool};
use tempfile::tempdir;

const CWD: &str = "/synthetic/fake-cli-workspace";
const CLI_ID: &str = "77777777-7777-4777-8777-777777777777";

struct ProcessGroupGuard {
    child: Option<Child>,
}

impl ProcessGroupGuard {
    fn spawn(mut command: Command) -> std::io::Result<Self> {
        use std::os::unix::process::CommandExt;

        // A dedicated process group lets Drop terminate both the shell and any
        // active sleep descendant when an assertion panics or times out.
        command.process_group(0);
        Ok(Self {
            child: Some(command.spawn()?),
        })
    }

    fn terminate(&mut self) -> std::io::Result<()> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let process_group = -(child.id() as i32);
        let result = unsafe { libc::kill(process_group, libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        child.wait().map(|_| ())
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

fn session() -> Session {
    Session {
        id: "11111111-1111-4111-8111-111111111111".into(),
        folder_id: "22222222-2222-4222-8222-222222222222".into(),
        tool: Tool::Codex,
        title: "Synthetic fake CLI session".into(),
        cli_session_id: None,
        status: Status::Stopped,
        model: None,
        extra_args: Vec::new(),
        created_at: "2026-07-21T12:00:00Z".into(),
        last_active_at: "2026-07-21T12:00:00Z".into(),
        was_open_in_tab: false,
    }
}

#[test]
fn fake_cli_writes_codex_session_then_can_be_killed_and_resumed() {
    use chrono::Datelike;

    let root = tempdir().unwrap();
    let launched_at = SystemTime::now();
    let launched_date: chrono::DateTime<chrono::Utc> = launched_at.into();
    let dated = root.path().join(format!(
        "sessions/{:04}/{:02}/{:02}",
        launched_date.year(),
        launched_date.month(),
        launched_date.day()
    ));
    fs::create_dir_all(&dated).unwrap();
    let output = dated.join(format!("rollout-synthetic-{CLI_ID}.jsonl"));
    let script = root.path().join("fake-codex.sh");
    fs::write(
        &script,
        r#"#!/bin/sh
output="$1"
cwd="$2"
id="$3"
printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\n' "$id" "$cwd" > "$output"
while :; do sleep 1; done
"#,
    )
    .unwrap();

    let mut command = Command::new("/bin/sh");
    command
        .arg(&script)
        .arg(&output)
        .arg(CWD)
        .arg(CLI_ID)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = ProcessGroupGuard::spawn(command).unwrap();
    let adapter = CodexAdapter::with_sessions_root(root.path().join("sessions"));
    let deadline = Instant::now() + Duration::from_secs(2);
    let discovered = loop {
        if let Some(id) = adapter
            .discover_session_id(Path::new(CWD), launched_at)
            .unwrap()
        {
            break id;
        }
        assert!(
            Instant::now() < deadline,
            "fake CLI session was not discovered"
        );
        thread::sleep(Duration::from_millis(20));
    };

    child.terminate().unwrap();
    let mut saved = session();
    saved.cli_session_id = Some(discovered);

    assert_eq!(
        adapter
            .resume(&saved, Path::new(CWD), &Settings::default())
            .unwrap(),
        SpawnSpec::new("codex", ["resume", CLI_ID], CWD)
    );
}
