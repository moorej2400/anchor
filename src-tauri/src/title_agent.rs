//! Hidden, reusable provider sessions that turn the first user prompt into a
//! short Anchor display title. These sessions never enter the visible registry.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::adapters::SpawnSpec;
use crate::durable_file::atomic_write;
use crate::models::{Settings, Tool};

const STATE_VERSION: u32 = 1;
const TITLE_TIMEOUT: Duration = Duration::from_secs(90);
const OUTPUT_LIMIT: u64 = 256 * 1024;
const MAX_TITLE_MESSAGE_BYTES: usize = 2 * 1024;
const TITLE_SYSTEM_PROMPT: &str = "Create a concise title for the supplied user message. Return only the title, with no quotes, explanation, markdown, or ending punctuation. The title must contain 3 to 5 words.";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleAgentState {
    version: u32,
    sessions: BTreeMap<String, String>,
}

pub struct TitleAgentStore {
    root: PathBuf,
}

pub struct TitleRequest {
    pub spec: SpawnSpec,
    pub state_key: String,
    pub preassigned_id: Option<String>,
}

pub struct TitleResponse {
    pub title: String,
}

pub struct TitleExecution {
    pub raw: String,
    pub failure: Option<&'static str>,
}

impl TitleAgentStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().join("title-agents"),
        }
    }

    pub fn workspace(&self, tool: Tool) -> Result<PathBuf, String> {
        let path = self.root.join("workspaces").join(tool_key(tool));
        fs::create_dir_all(&path).map_err(|_| {
            "TITLE_AGENT_DIR_FAILED: could not create the private title workspace".to_string()
        })?;
        Ok(path)
    }

    pub fn session_id(&self, key: &str) -> Result<Option<String>, String> {
        let state = self.load()?;
        let Some(id) = state.sessions.get(key) else {
            return Ok(None);
        };
        if !valid_provider_session_id(id) {
            return Err("TITLE_AGENT_ID_INVALID: saved title session ID is invalid".into());
        }
        Ok(Some(id.clone()))
    }

    pub fn save_session_id(&self, key: String, id: String) -> Result<(), String> {
        if !valid_provider_session_id(&id) {
            return Err("TITLE_AGENT_ID_INVALID: provider returned an invalid session ID".into());
        }
        let mut state = self.load()?;
        state.version = STATE_VERSION;
        state.sessions.insert(key, id);
        let bytes = serde_json::to_vec_pretty(&state)
            .map_err(|_| "TITLE_AGENT_STATE_FAILED: could not serialize title state".to_string())?;
        atomic_write(&self.state_path(), &bytes, "TITLE_AGENT_STATE_FAILED")
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn load(&self) -> Result<TitleAgentState, String> {
        let bytes = match fs::read(self.state_path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TitleAgentState {
                    version: STATE_VERSION,
                    sessions: BTreeMap::new(),
                });
            }
            Err(_) => return Err("TITLE_AGENT_STATE_FAILED: could not read title state".into()),
        };
        let state: TitleAgentState = serde_json::from_slice(&bytes)
            .map_err(|_| "TITLE_AGENT_STATE_FAILED: title state is invalid".to_string())?;
        if state.version != STATE_VERSION {
            return Err("TITLE_AGENT_STATE_FAILED: title state version is unsupported".into());
        }
        Ok(state)
    }
}

pub fn build_request(
    tool: Tool,
    codex_profile: Option<&str>,
    prior_id: Option<&str>,
    message: &str,
    cwd: &Path,
) -> Result<TitleRequest, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("TITLE_PROMPT_INVALID: title input is empty".into());
    }
    if prior_id.is_some_and(|id| !valid_provider_session_id(id)) {
        return Err("TITLE_AGENT_ID_INVALID: saved title session ID is invalid".into());
    }

    let state_key = session_key(tool, codex_profile);
    // npm-installed CLIs are `.cmd` launchers on Windows. Their arguments pass
    // through cmd.exe, so encode untrusted user text rather than allowing shell
    // control characters into that command line. The bounded prefix also stays
    // below cmd.exe's command-length limit.
    let bounded_message = utf8_prefix(message, MAX_TITLE_MESSAGE_BYTES);
    let encoded_message = base64_encode(bounded_message.as_bytes());
    let encoded_prompt = format!(
        "The original UTF-8 user message is base64 encoded: {encoded_message}. Decode it before creating the title."
    );
    let prompt = format!("{TITLE_SYSTEM_PROMPT} {encoded_prompt}");
    let mut preassigned_id = None;
    let spec = match tool {
        Tool::Claude => {
            let id = prior_id
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string());
            preassigned_id = Some(id.clone());
            let mut args = vec![
                "--print".into(),
                "--output-format".into(),
                "json".into(),
                "--tools".into(),
                "".into(),
                "--permission-prompts".into(),
                "none".into(),
                "--safe-mode".into(),
                "--system-prompt".into(),
                TITLE_SYSTEM_PROMPT.into(),
            ];
            args.extend(if prior_id.is_some() {
                vec!["--resume".into(), id]
            } else {
                vec!["--session-id".into(), id]
            });
            args.push(encoded_prompt);
            SpawnSpec::new("claude", args, cwd)
        }
        Tool::Copilot => {
            let id = prior_id
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string());
            preassigned_id = Some(id.clone());
            SpawnSpec::new(
                "copilot",
                [
                    "--prompt".to_owned(),
                    prompt,
                    "--silent".into(),
                    "--output-format".into(),
                    "json".into(),
                    "--available-tools=".into(),
                    format!("--session-id={id}"),
                ],
                cwd,
            )
        }
        Tool::Codex => {
            let mut args = Vec::new();
            if let Some(profile) = codex_profile {
                args.extend(["--profile".into(), profile.to_owned()]);
            }
            args.push("exec".into());
            if let Some(id) = prior_id {
                args.extend([
                    "resume".into(),
                    "--json".into(),
                    "--skip-git-repo-check".into(),
                    "--ignore-rules".into(),
                    id.to_owned(),
                    prompt,
                ]);
            } else {
                args.extend([
                    "--json".into(),
                    "--sandbox".into(),
                    "read-only".into(),
                    "--skip-git-repo-check".into(),
                    "--ignore-rules".into(),
                    prompt,
                ]);
            }
            SpawnSpec::new("codex", args, cwd)
        }
        Tool::Opencode => {
            let mut args = vec![
                "run".into(),
                "--pure".into(),
                "--format".into(),
                "json".into(),
                "--title".into(),
                "Anchor Title Generator".into(),
                "--dir".into(),
                cwd.to_string_lossy().into_owned(),
            ];
            if let Some(id) = prior_id {
                args.extend(["--session".into(), id.to_owned()]);
            }
            args.push(prompt);
            SpawnSpec::new("opencode", args, cwd)
        }
        Tool::Terminal => {
            return Err(
                "TITLE_GENERATION_UNSUPPORTED: terminal sessions have no AI title agent".into(),
            )
        }
    };

    Ok(TitleRequest {
        spec,
        state_key,
        preassigned_id,
    })
}

pub fn execute(spec: &SpawnSpec, settings: &Settings) -> Result<TitleExecution, String> {
    let mut stdout_file = tempfile::NamedTempFile::new()
        .map_err(|_| "TITLE_GENERATION_FAILED: could not create output capture".to_string())?;
    let mut stderr_file = tempfile::NamedTempFile::new()
        .map_err(|_| "TITLE_GENERATION_FAILED: could not create error capture".to_string())?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file.reopen().map_err(|_| {
            "TITLE_GENERATION_FAILED: could not open output capture".to_string()
        })?))
        .stderr(Stdio::from(stderr_file.reopen().map_err(|_| {
            "TITLE_GENERATION_FAILED: could not open error capture".to_string()
        })?));
    for env in &settings.env_vars {
        command.env(&env.key, &env.value);
    }
    if let Some(path) = title_search_path(spec, settings) {
        command.env("PATH", path);
    }
    configure_hidden_process(&mut command);

    let mut child = command
        .spawn()
        .map_err(|_| "TITLE_GENERATION_FAILED: could not start title agent".to_string())?;
    let deadline = Instant::now() + TITLE_TIMEOUT;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => {
                terminate_process_tree(&mut child);
                timed_out = true;
                break child.wait().map_err(|_| {
                    "TITLE_GENERATION_FAILED: title agent did not stop".to_string()
                })?;
            }
        }
    };
    let stdout = read_capture(stdout_file.as_file_mut())?;
    let stderr = read_capture(stderr_file.as_file_mut())?;
    let bytes = if stdout.is_empty() { stderr } else { stdout };
    let raw = String::from_utf8(bytes)
        .map_err(|_| "TITLE_GENERATION_FAILED: title agent output was not UTF-8".to_string())?;
    let failure = if timed_out {
        Some("TITLE_GENERATION_FAILED: title agent timed out")
    } else if !status.success() {
        Some("TITLE_GENERATION_FAILED: title agent rejected the request")
    } else {
        None
    };
    Ok(TitleExecution { raw, failure })
}

pub fn parse_response(raw: &str) -> Result<TitleResponse, String> {
    let mut ignored_ids = Vec::new();
    let mut candidates = Vec::new();
    collect_output(raw, &mut ignored_ids, &mut candidates);
    let title = candidates
        .into_iter()
        .rev()
        .find_map(|candidate| sanitize_title(&candidate))
        .ok_or_else(|| {
            "TITLE_GENERATION_FAILED: title agent returned no valid title".to_string()
        })?;
    Ok(TitleResponse { title })
}

pub fn discover_session_id(raw: &str) -> Option<String> {
    let mut ids = Vec::new();
    let mut ignored_candidates = Vec::new();
    collect_output(raw, &mut ids, &mut ignored_candidates);
    ids.into_iter()
        .rev()
        .find(|id| valid_provider_session_id(id))
}

pub fn session_key(tool: Tool, codex_profile: Option<&str>) -> String {
    match (tool, codex_profile) {
        (Tool::Codex, Some(profile)) => format!("codex:{profile}"),
        _ => tool_key(tool).to_owned(),
    }
}

pub fn valid_provider_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn collect_response_values(
    value: &serde_json::Value,
    ids: &mut Vec<String>,
    candidates: &mut Vec<String>,
) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "session_id" | "sessionId" | "sessionID" | "thread_id" | "threadId"
                ) {
                    if let Some(id) = value.as_str() {
                        ids.push(id.to_owned());
                    }
                }
                if matches!(key.as_str(), "result" | "text" | "content") {
                    if let Some(candidate) = value.as_str() {
                        candidates.push(candidate.to_owned());
                    }
                }
                collect_response_values(value, ids, candidates);
            }
        }
        serde_json::Value::Array(array) => {
            for value in array {
                collect_response_values(value, ids, candidates);
            }
        }
        _ => {}
    }
}

fn collect_output(raw: &str, ids: &mut Vec<String>, candidates: &mut Vec<String>) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(candidate) = value.as_str() {
            candidates.push(candidate.to_owned());
        } else {
            collect_response_values(&value, ids, candidates);
        }
        return;
    }
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(candidate) = value.as_str() {
                candidates.push(candidate.to_owned());
            } else {
                collect_response_values(&value, ids, candidates);
            }
        } else {
            candidates.push(line.to_owned());
        }
    }
}

fn sanitize_title(raw: &str) -> Option<String> {
    let first_line = raw.lines().find(|line| !line.trim().is_empty())?;
    let title = first_line
        .trim()
        .trim_matches(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '"' | '\'' | '`' | '#' | '*' | '_' | '-' | ':' | '.' | '!'
                )
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let words = title.split_whitespace().count();
    ((3..=5).contains(&words) && title.chars().count() <= 80).then_some(title)
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

fn title_search_path(spec: &SpawnSpec, settings: &Settings) -> Option<std::ffi::OsString> {
    let configured = settings
        .env_vars
        .iter()
        .rev()
        .find(|env| {
            if cfg!(windows) {
                env.key.eq_ignore_ascii_case("PATH")
            } else {
                env.key == "PATH"
            }
        })
        .map(|env| std::ffi::OsString::from(&env.value))
        .or_else(|| std::env::var_os("PATH"));
    let mut directories = spec.launcher_directory.iter().cloned().collect::<Vec<_>>();
    directories.extend(
        configured
            .as_deref()
            .map(std::env::split_paths)
            .into_iter()
            .flatten(),
    );
    std::env::join_paths(directories).ok()
}

fn read_capture(file: &mut fs::File) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "TITLE_GENERATION_FAILED: could not read title output".to_string())?;
    let mut captured = Vec::new();
    file.take(OUTPUT_LIMIT)
        .read_to_end(&mut captured)
        .map_err(|_| "TITLE_GENERATION_FAILED: could not read title output".to_string())?;
    Ok(captured)
}

#[cfg(unix)]
fn configure_hidden_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_hidden_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut std::process::Child) {
    unsafe {
        let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut std::process::Child) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .status();
    let _ = child.kill();
}

fn tool_key(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude => "claude",
        Tool::Codex => "codex",
        Tool::Copilot => "copilot",
        Tool::Opencode => "opencode",
        Tool::Terminal => "terminal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_supported_json_event_shapes_and_enforces_short_titles() {
        let raw = concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"synthetic-thread-id\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Repair Missing Session Identity\"}}\n"
        );

        let parsed = parse_response(raw).unwrap();

        assert_eq!(parsed.title, "Repair Missing Session Identity");
        assert_eq!(
            discover_session_id(raw).as_deref(),
            Some("synthetic-thread-id")
        );
        assert!(parse_response("{\"result\":\"Too short\"}").is_err());
        assert!(parse_response("{\"result\":\"One Two Three Four Five Six\"}").is_err());
        assert_eq!(
            parse_response("{\n  \"result\": \"Name The Existing Session\"\n}")
                .unwrap()
                .title,
            "Name The Existing Session"
        );
    }

    #[test]
    fn persists_one_private_session_id_per_harness_key() {
        let root = tempdir().unwrap();
        let store = TitleAgentStore::new(root.path());

        store
            .save_session_id("codex:proxy".into(), "synthetic-session-id".into())
            .unwrap();

        assert_eq!(
            store.session_id("codex:proxy").unwrap().as_deref(),
            Some("synthetic-session-id")
        );
        assert!(store.session_id("codex:other").unwrap().is_none());
    }

    #[test]
    fn reused_requests_target_the_saved_provider_identity() {
        let root = tempdir().unwrap();
        let request = build_request(
            Tool::Codex,
            Some("proxy"),
            Some("synthetic-session-id"),
            "Fix the session identity",
            root.path(),
        )
        .unwrap();

        assert_eq!(request.state_key, "codex:proxy");
        assert_eq!(
            request.spec.args,
            [
                "--profile",
                "proxy",
                "exec",
                "resume",
                "--json",
                "--skip-git-repo-check",
                "--ignore-rules",
                "synthetic-session-id",
                "Create a concise title for the supplied user message. Return only the title, with no quotes, explanation, markdown, or ending punctuation. The title must contain 3 to 5 words. The original UTF-8 user message is base64 encoded: Rml4IHRoZSBzZXNzaW9uIGlkZW50aXR5. Decode it before creating the title.",
            ]
        );
    }

    #[test]
    fn title_prompts_encode_windows_command_characters() {
        let root = tempdir().unwrap();
        let request =
            build_request(Tool::Copilot, None, None, "Fix A & B \"now\"", root.path()).unwrap();
        let prompt = &request.spec.args[1];

        assert!(!prompt.contains('&'));
        assert!(!prompt.contains('"'));
        assert!(prompt.contains("Rml4IEEgJiBCICJub3ci"));
    }
}
