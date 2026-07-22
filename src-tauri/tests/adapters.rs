#[path = "../src/adapters/mod.rs"]
mod adapters;
#[path = "../src/models.rs"]
mod models;

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use adapters::claude::ClaudeAdapter;
use adapters::codex::CodexAdapter;
use adapters::copilot::CopilotAdapter;
use adapters::opencode::OpencodeAdapter;
use adapters::terminal::TerminalAdapter;
use adapters::{Adapter, IdCapture, SpawnSpec};
use models::{Session, Settings, Status, Tool};
use rusqlite::Connection;
use tempfile::tempdir;

const CWD: &str = "/synthetic/workspace";

fn session(tool: Tool) -> Session {
    Session {
        id: "11111111-1111-4111-8111-111111111111".into(),
        folder_id: "22222222-2222-4222-8222-222222222222".into(),
        tool,
        title: "Synthetic adapter session".into(),
        cli_session_id: None,
        status: Status::Stopped,
        model: None,
        extra_args: vec!["--synthetic-flag".into(), "value".into()],
        created_at: "2026-07-21T12:00:00Z".into(),
        last_active_at: "2026-07-21T12:00:00Z".into(),
        was_open_in_tab: false,
    }
}

fn assert_preassigned(capture: IdCapture) -> String {
    match capture {
        IdCapture::PreAssigned(id) => {
            uuid::Uuid::parse_str(&id).expect("pre-assigned ID must be a UUID");
            id
        }
        _ => panic!("expected a pre-assigned session ID"),
    }
}

fn utc_time(year: i32, month: u32, day: u32, hour: u32) -> SystemTime {
    use chrono::TimeZone;

    chrono::Utc
        .with_ymd_and_hms(year, month, day, hour, 0, 0)
        .single()
        .unwrap()
        .into()
}

fn write_rollout(path: &Path, id: &str, cwd: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":{}}}}}\n",
            serde_json::to_string(&cwd.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
}

#[test]
fn claude_launch_preassigns_uuid_and_resume_uses_saved_or_picker_form() {
    let adapter = ClaudeAdapter;
    let mut session = session(Tool::Claude);
    let settings = Settings::default();

    let (launch, capture) = adapter.launch(&session, Path::new(CWD), &settings).unwrap();
    let cli_id = assert_preassigned(capture);

    assert_eq!(
        launch,
        SpawnSpec::new(
            "claude",
            ["--session-id", &cli_id, "--synthetic-flag", "value"],
            CWD,
        )
    );
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("claude", ["--resume"], CWD)
    );

    session.cli_session_id = Some(cli_id.clone());
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("claude", ["--resume", &cli_id], CWD)
    );
}

#[test]
fn copilot_launch_preassigns_uuid_and_resume_uses_saved_or_picker_form() {
    let adapter = CopilotAdapter;
    let mut session = session(Tool::Copilot);
    let settings = Settings::default();

    let (launch, capture) = adapter.launch(&session, Path::new(CWD), &settings).unwrap();
    let cli_id = assert_preassigned(capture);

    assert_eq!(
        launch,
        SpawnSpec::new(
            "copilot",
            ["--resume", &cli_id, "--synthetic-flag", "value"],
            CWD,
        )
    );
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("copilot", ["--resume"], CWD)
    );

    session.cli_session_id = Some(cli_id.clone());
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("copilot", ["--resume", &cli_id], CWD)
    );
}

#[test]
fn codex_launch_appends_extra_args_but_resume_never_does() {
    let root = tempdir().unwrap();
    let adapter = CodexAdapter::with_sessions_root(root.path());
    let mut session = session(Tool::Codex);
    let settings = Settings::default();

    let (launch, capture) = adapter.launch(&session, Path::new(CWD), &settings).unwrap();

    assert_eq!(
        launch,
        SpawnSpec::new("codex", ["--synthetic-flag", "value"], CWD)
    );
    assert_eq!(capture, IdCapture::Discover);
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("codex", ["resume"], CWD)
    );

    session.cli_session_id = Some("33333333-3333-4333-8333-333333333333".into());
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new(
            "codex",
            ["resume", "33333333-3333-4333-8333-333333333333"],
            CWD,
        )
    );
}

#[test]
fn opencode_launch_appends_extra_args_but_resume_never_does() {
    let root = tempdir().unwrap();
    let adapter = OpencodeAdapter::with_database_path(root.path().join("missing.db"));
    let mut session = session(Tool::Opencode);
    let settings = Settings::default();

    let (launch, capture) = adapter.launch(&session, Path::new(CWD), &settings).unwrap();

    assert_eq!(
        launch,
        SpawnSpec::new("opencode", ["--synthetic-flag", "value"], CWD)
    );
    assert_eq!(capture, IdCapture::Discover);
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("opencode", std::iter::empty::<&str>(), CWD)
    );

    session.cli_session_id = Some("synthetic-opencode-id".into());
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("opencode", ["--session", "synthetic-opencode-id"], CWD)
    );
}

#[cfg(unix)]
#[test]
fn opencode_default_database_uses_home_local_share_path() {
    let home = dirs::home_dir().expect("test platform must provide a home directory");
    let xdg = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from);

    assert_eq!(
        OpencodeAdapter::default_database_path(),
        OpencodeAdapter::resolve_database_path(Some(&home), xdg.as_deref(), None, false)
    );
}

#[test]
fn opencode_data_path_resolver_honors_xdg_and_windows_data_roots() {
    let home = Path::new("/synthetic/home");
    let xdg = Path::new("/synthetic/xdg");
    let windows_data = Path::new(r"C:\Synthetic\AppData\Roaming");

    assert_eq!(
        OpencodeAdapter::resolve_database_path(Some(home), Some(xdg), None, false),
        Some(xdg.join("opencode/opencode.db"))
    );
    assert_eq!(
        OpencodeAdapter::resolve_database_path(Some(home), None, None, false),
        Some(home.join(".local/share/opencode/opencode.db"))
    );
    assert_eq!(
        OpencodeAdapter::resolve_database_path(None, Some(xdg), Some(windows_data), true),
        Some(windows_data.join("opencode/opencode.db"))
    );
}

#[test]
fn sqlite_uri_formats_windows_drive_paths_and_strips_extended_prefix() {
    assert_eq!(
        adapters::opencode::immutable_sqlite_uri_text(r"\\?\C:\Synthetic Folder\db#1.sqlite", true),
        Some("file:/C:/Synthetic%20Folder/db%231.sqlite?immutable=1".into())
    );
}

#[test]
fn windows_path_comparison_is_case_insensitive_and_lexically_normalized() {
    assert!(adapters::windows_paths_match(
        r"C:\Synthetic\Workspace\..\Project\.",
        r"c:/synthetic/project"
    ));
    assert!(!adapters::windows_paths_match(
        r"C:\Synthetic\Project-One",
        r"C:\Synthetic\Project-Two"
    ));
}

#[test]
fn adapter_owned_extra_args_are_rejected_without_echoing_values() {
    let settings = Settings::default();
    let root = tempdir().unwrap();
    let cases: Vec<(Box<dyn Adapter>, Tool, Vec<&str>)> = vec![
        (
            Box::new(ClaudeAdapter),
            Tool::Claude,
            vec!["--session-id", "secret-claude"],
        ),
        (
            Box::new(CopilotAdapter),
            Tool::Copilot,
            vec!["--resume=secret-copilot"],
        ),
        (
            Box::new(OpencodeAdapter::with_database_path(
                root.path().join("missing.db"),
            )),
            Tool::Opencode,
            vec!["--session", "secret-opencode"],
        ),
        (
            Box::new(CodexAdapter::with_sessions_root(root.path())),
            Tool::Codex,
            vec!["resume", "secret-codex"],
        ),
        (
            Box::new(CodexAdapter::with_sessions_root(root.path())),
            Tool::Codex,
            vec!["fork", "secret-fork"],
        ),
    ];

    for (adapter, tool, extra_args) in cases {
        let mut record = session(tool);
        record.extra_args = extra_args.into_iter().map(str::to_owned).collect();
        let error = adapter
            .launch(&record, Path::new(CWD), &settings)
            .unwrap_err();
        assert_eq!(
            error,
            format!(
                "INVALID_EXTRA_ARGS: {} launch arguments cannot change session identity",
                match tool {
                    Tool::Claude => "claude",
                    Tool::Codex => "codex",
                    Tool::Copilot => "copilot",
                    Tool::Opencode => "opencode",
                    Tool::Terminal => "terminal",
                }
            )
        );
        assert!(!error.contains("secret"));
    }
}

#[test]
fn attached_short_identity_values_are_rejected_but_double_dash_and_other_flags_are_safe() {
    let settings = Settings::default();
    let root = tempdir().unwrap();
    let rejected: Vec<(Box<dyn Adapter>, Tool, &str)> = vec![
        (Box::new(ClaudeAdapter), Tool::Claude, "-rsecret"),
        (Box::new(ClaudeAdapter), Tool::Claude, "-r=secret"),
        (Box::new(CopilotAdapter), Tool::Copilot, "-rsecret"),
        (
            Box::new(OpencodeAdapter::with_database_path(
                root.path().join("missing.db"),
            )),
            Tool::Opencode,
            "-ssecret",
        ),
        (
            Box::new(OpencodeAdapter::with_database_path(
                root.path().join("missing.db"),
            )),
            Tool::Opencode,
            "-s=secret",
        ),
    ];
    for (adapter, tool, argument) in rejected {
        let mut record = session(tool);
        record.extra_args = vec![argument.into()];
        let error = adapter
            .launch(&record, Path::new(CWD), &settings)
            .unwrap_err();
        assert!(error.starts_with("INVALID_EXTRA_ARGS:"));
        assert!(!error.contains("secret"));
    }

    let safe_cases: Vec<(Box<dyn Adapter>, Tool, Vec<&str>)> = vec![
        (Box::new(ClaudeAdapter), Tool::Claude, vec!["-qvalue"]),
        (Box::new(CopilotAdapter), Tool::Copilot, vec!["-qvalue"]),
        (
            Box::new(OpencodeAdapter::with_database_path(
                root.path().join("missing.db"),
            )),
            Tool::Opencode,
            vec!["-qvalue"],
        ),
        (
            Box::new(CodexAdapter::with_sessions_root(root.path())),
            Tool::Codex,
            vec!["--", "resume"],
        ),
        (
            Box::new(ClaudeAdapter),
            Tool::Claude,
            vec!["--", "--resume"],
        ),
    ];
    for (adapter, tool, arguments) in safe_cases {
        let mut record = session(tool);
        record.extra_args = arguments.into_iter().map(str::to_owned).collect();
        assert!(
            adapter.launch(&record, Path::new(CWD), &settings).is_ok(),
            "safe arguments were rejected for {tool:?}"
        );
    }
}

#[test]
fn terminal_uses_configured_shell_and_launch_only_extra_args() {
    let adapter = TerminalAdapter;
    let session = session(Tool::Terminal);
    let mut settings = Settings::default();
    settings.shell = "/synthetic/bin/shell".into();

    let (launch, capture) = adapter.launch(&session, Path::new(CWD), &settings).unwrap();

    assert_eq!(
        launch,
        SpawnSpec::new("/synthetic/bin/shell", ["--synthetic-flag", "value"], CWD,)
    );
    assert_eq!(capture, IdCapture::None);
    assert_eq!(
        adapter.resume(&session, Path::new(CWD), &settings).unwrap(),
        SpawnSpec::new("/synthetic/bin/shell", std::iter::empty::<&str>(), CWD)
    );
}

#[test]
fn codex_discovers_newest_matching_first_line_fixture() {
    let root = tempdir().unwrap();
    let dated = root.path().join("2026/07/21");
    fs::create_dir_all(&dated).unwrap();
    let launch_time = utc_time(2026, 7, 21, 12);
    let fixture = include_str!("fixtures/codex-rollout.jsonl").replace("__CWD__", CWD);
    fs::write(
        dated.join("rollout-2026-07-21T12-00-00-44444444-4444-4444-8444-444444444444.jsonl"),
        fixture,
    )
    .unwrap();
    fs::write(
        dated.join("rollout-2026-07-21T12-00-01-55555555-5555-4555-8555-555555555555.jsonl"),
        "{malformed\n",
    )
    .unwrap();
    fs::write(
        dated.join("rollout-2026-07-21T12-00-02-66666666-6666-4666-8666-666666666666.jsonl"),
        r#"{"type":"session_meta","payload":{"id":"not-the-filename-id","cwd":"/synthetic/workspace"}}"#,
    )
    .unwrap();
    let adapter = CodexAdapter::with_sessions_root(root.path());

    assert_eq!(
        adapter
            .discover_session_id_at(Path::new(CWD), launch_time, launch_time)
            .unwrap(),
        Some("44444444-4444-4444-8444-444444444444".into())
    );
}

#[test]
fn codex_missing_or_malformed_store_is_pending() {
    let root = tempdir().unwrap();
    let adapter = CodexAdapter::with_sessions_root(root.path().join("missing"));
    assert_eq!(
        adapter
            .discover_session_id_at(
                Path::new(CWD),
                utc_time(2026, 7, 21, 12),
                utc_time(2026, 7, 21, 12),
            )
            .unwrap(),
        None
    );

    let malformed_root = root.path().join("malformed");
    let malformed_date = malformed_root.join("2026/07/21");
    fs::create_dir_all(&malformed_date).unwrap();
    fs::write(malformed_date.join("rollout-malformed.jsonl"), "not json\n").unwrap();
    let adapter = CodexAdapter::with_sessions_root(malformed_root);
    assert_eq!(
        adapter
            .discover_session_id_at(
                Path::new(CWD),
                utc_time(2026, 7, 21, 12),
                utc_time(2026, 7, 21, 12),
            )
            .unwrap(),
        None
    );
}

#[cfg(unix)]
#[test]
fn cwd_comparison_canonicalizes_existing_symlink_aliases() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let real = root.path().join("real-workspace");
    let alias = root.path().join("workspace-alias");
    fs::create_dir(&real).unwrap();
    symlink(&real, &alias).unwrap();

    assert!(adapters::paths_match(&real, &alias));
}

#[test]
fn codex_limits_date_scan_and_allows_slightly_backdated_mtime() {
    let root = tempdir().unwrap();
    let launch = utc_time(2026, 7, 21, 0);
    let now = utc_time(2026, 7, 22, 12);
    let matching_id = "88888888-8888-4888-8888-888888888888";
    let matching = root
        .path()
        .join("2026/07/21")
        .join(format!("rollout-matching-{matching_id}.jsonl"));
    write_rollout(&matching, matching_id, Path::new(CWD));
    filetime::set_file_mtime(
        &matching,
        filetime::FileTime::from_system_time(launch - Duration::from_millis(500)),
    )
    .unwrap();

    let out_of_range_id = "99999999-9999-4999-8999-999999999999";
    let out_of_range = root
        .path()
        .join("2020/01/01")
        .join(format!("rollout-old-date-{out_of_range_id}.jsonl"));
    write_rollout(&out_of_range, out_of_range_id, Path::new(CWD));
    filetime::set_file_mtime(
        &out_of_range,
        filetime::FileTime::from_system_time(now + Duration::from_secs(60)),
    )
    .unwrap();
    let adapter = CodexAdapter::with_sessions_root(root.path());

    assert_eq!(
        adapter
            .discover_session_id_at(Path::new(CWD), launch, now)
            .unwrap(),
        Some(matching_id.into())
    );
}

#[test]
fn codex_scans_adjacent_utc_dates_for_machine_local_store_boundaries() {
    let launch = utc_time(2026, 7, 21, 12);
    for (date, id) in [
        ("2026/07/20", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        ("2026/07/22", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    ] {
        let root = tempdir().unwrap();
        let rollout = root
            .path()
            .join(date)
            .join(format!("rollout-timezone-boundary-{id}.jsonl"));
        write_rollout(&rollout, id, Path::new(CWD));
        filetime::set_file_mtime(&rollout, filetime::FileTime::from_system_time(launch)).unwrap();
        let adapter = CodexAdapter::with_sessions_root(root.path());

        assert_eq!(
            adapter
                .discover_session_id_at(Path::new(CWD), launch, launch)
                .unwrap(),
            Some(id.into())
        );
    }
}

#[cfg(unix)]
#[test]
fn codex_skips_unreadable_relevant_date_directory_and_finds_other_match() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let launch = utc_time(2026, 7, 21, 12);
    let now = utc_time(2026, 7, 22, 12);
    let unreadable = root.path().join("2026/07/21");
    fs::create_dir_all(&unreadable).unwrap();
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();

    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let matching = root
        .path()
        .join("2026/07/22")
        .join(format!("rollout-readable-{id}.jsonl"));
    write_rollout(&matching, id, Path::new(CWD));
    filetime::set_file_mtime(&matching, filetime::FileTime::from_system_time(now)).unwrap();
    let adapter = CodexAdapter::with_sessions_root(root.path());

    let result = adapter
        .discover_session_id_at(Path::new(CWD), launch, now)
        .unwrap();
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(result, Some(id.into()));
}

#[test]
fn opencode_discovers_newest_matching_session_from_read_only_database() {
    let root = tempdir().unwrap();
    let database = root.path().join("opencode.db");
    fs::write(&database, include_bytes!("fixtures/opencode.db")).unwrap();
    let launch_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_000);
    let adapter = OpencodeAdapter::with_database_path(&database);

    assert_eq!(
        adapter
            .discover_session_id(Path::new(CWD), launch_time)
            .unwrap(),
        Some("matching-newest".into())
    );

    let connection =
        Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let count: i64 = connection
        .query_row("SELECT count(*) FROM session", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 4);
}

#[test]
fn opencode_missing_malformed_or_unknown_schema_is_pending() {
    let root = tempdir().unwrap();
    for database in [
        root.path().join("missing.db"),
        root.path().join("malformed.db"),
    ] {
        if database.file_name().unwrap() == "malformed.db" {
            fs::write(&database, "not sqlite").unwrap();
        }
        let adapter = OpencodeAdapter::with_database_path(database);
        assert_eq!(
            adapter
                .discover_session_id(Path::new(CWD), SystemTime::UNIX_EPOCH)
                .unwrap(),
            None
        );
    }

    let database = root.path().join("unknown-schema.db");
    Connection::open(&database)
        .unwrap()
        .execute("CREATE TABLE unrelated (id TEXT)", [])
        .unwrap();
    let adapter = OpencodeAdapter::with_database_path(database);
    assert_eq!(
        adapter
            .discover_session_id(Path::new(CWD), SystemTime::UNIX_EPOCH)
            .unwrap(),
        None
    );
}
