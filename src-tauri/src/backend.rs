//! Application-level orchestration for the persisted registry and live PTYs.
//!
//! Tauri commands deliberately delegate here so the core promise--persisting a
//! session identity before its process can produce output--is testable without
//! a webview or a real CLI installation.

use std::ffi::{OsStr, OsString};
use std::fs;
#[cfg(unix)]
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, SystemTime};

use chrono::Utc;

use crate::adapters::{adapter_for, IdCapture, SpawnSpec};
use crate::models::{AppState, CliInfo, Folder, Session, Settings, Status, Tool};
use crate::pty::{PtyEvent, PtyManager};
use crate::registry::Registry;
use crate::scrollback::{format_restored_scrollback, ScrollbackStore};
use crate::settings::{expand_tilde, SettingsStore};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

pub trait PtyRuntime: Send + Sync {
    fn spawn(
        &self,
        session_id: &str,
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
        settings: &Settings,
    ) -> Result<(), String>;
    fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String>;
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String>;
    fn stop(&self, session_id: &str) -> Result<(), String>;
    fn replay_output(&self, session_id: &str) -> Result<(), String>;
    fn is_live(&self, session_id: &str) -> bool;
}

impl PtyRuntime for PtyManager {
    fn spawn(
        &self,
        session_id: &str,
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
        settings: &Settings,
    ) -> Result<(), String> {
        self.spawn(session_id, spec, cols, rows, settings)
    }

    fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        self.write(session_id, data)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.resize(session_id, cols, rows)
    }

    fn stop(&self, session_id: &str) -> Result<(), String> {
        self.stop(session_id)
    }

    fn replay_output(&self, session_id: &str) -> Result<(), String> {
        self.replay_output(session_id)
    }

    fn is_live(&self, session_id: &str) -> bool {
        self.is_live(session_id)
    }
}

/// UI side effects are abstracted so mutation and ordering tests remain local.
pub trait BackendEvents: Send + Sync {
    fn pty_output(&self, _session_id: &str, _data: &str) {}
    fn session_status(&self, _session_id: &str, _status: Status, _exit_code: Option<i32>) {}
    fn session_updated(&self, _session: &Session) {}
    fn attention_count(&self, _waiting: u32, _notify: bool) {}
    fn background_error(&self, _message: &str) {}
}

#[cfg(test)]
pub struct NoopEvents;
#[cfg(test)]
impl BackendEvents for NoopEvents {}

pub struct Backend {
    registry: Mutex<Registry>,
    settings: Mutex<Settings>,
    settings_store: SettingsStore,
    runtime: Arc<dyn PtyRuntime>,
    events: Arc<dyn BackendEvents>,
    enforce_executable_checks: bool,
    auto_restore_started: AtomicBool,
    mutation: Mutex<()>,
    operations: Mutex<()>,
    #[cfg(test)]
    discovery_starts: AtomicUsize,
}

impl Backend {
    /// Construct production state. The cyclic weak reference lets PTY threads
    /// report through Backend without either side owning the other forever.
    pub fn platform(events: Arc<dyn BackendEvents>) -> Result<Arc<Self>, String> {
        let settings_store = SettingsStore::platform()?;
        let settings = settings_store.load()?;
        let backup_path = expand_tilde(&settings.backup_path)?;
        let registry = Registry::load_from_backup_path(&backup_path)?;
        ScrollbackStore::new(&backup_path).prune(settings.retention_days)?;

        Ok(Arc::new_cyclic(move |weak: &Weak<Self>| {
            let weak = weak.clone();
            let runtime: Arc<dyn PtyRuntime> = Arc::new(PtyManager::with_callback(move |event| {
                if let Some(backend) = weak.upgrade() {
                    backend.handle_pty_event(event);
                }
            }));
            Self {
                registry: Mutex::new(registry),
                settings: Mutex::new(settings),
                settings_store,
                runtime,
                events,
                enforce_executable_checks: true,
                auto_restore_started: AtomicBool::new(false),
                mutation: Mutex::new(()),
                operations: Mutex::new(()),
                #[cfg(test)]
                discovery_starts: AtomicUsize::new(0),
            }
        }))
    }

    #[cfg(test)]
    fn for_test(
        settings_store: SettingsStore,
        settings: Settings,
        registry: Registry,
        runtime: Arc<dyn PtyRuntime>,
        events: Arc<dyn BackendEvents>,
    ) -> Arc<Self> {
        Arc::new(Self {
            registry: Mutex::new(registry),
            settings: Mutex::new(settings),
            settings_store,
            runtime,
            events,
            enforce_executable_checks: false,
            auto_restore_started: AtomicBool::new(false),
            mutation: Mutex::new(()),
            operations: Mutex::new(()),
            discovery_starts: AtomicUsize::new(0),
        })
    }

    #[cfg(test)]
    fn for_test_real(
        settings_store: SettingsStore,
        settings: Settings,
        registry: Registry,
        events: Arc<dyn BackendEvents>,
    ) -> Arc<Self> {
        Arc::new_cyclic(move |weak: &Weak<Self>| {
            let weak = weak.clone();
            let runtime: Arc<dyn PtyRuntime> = Arc::new(PtyManager::with_callback(move |event| {
                if let Some(backend) = weak.upgrade() {
                    backend.handle_pty_event(event);
                }
            }));
            Self {
                registry: Mutex::new(registry),
                settings: Mutex::new(settings),
                settings_store,
                runtime,
                events,
                enforce_executable_checks: false,
                auto_restore_started: AtomicBool::new(false),
                mutation: Mutex::new(()),
                operations: Mutex::new(()),
                discovery_starts: AtomicUsize::new(0),
            }
        })
    }

    pub fn get_state(&self) -> Result<AppState, String> {
        Ok(self.registry.lock().map_err(lock_error)?.snapshot())
    }

    pub fn create_folder(&self, path: String, name: Option<String>) -> Result<Folder, String> {
        let expanded = expand_tilde(&path)?;
        if !expanded.is_dir() {
            return Err("DIR_NOT_FOUND: folder path does not exist".into());
        }
        let canonical = fs::canonicalize(&expanded)
            .map_err(|_| "DIR_NOT_FOUND: folder path could not be resolved".to_string())?;
        let canonical_path = canonical
            .to_str()
            .ok_or_else(|| "DIR_PATH_INVALID: folder path is not valid UTF-8".to_string())?
            .to_owned();
        let default_name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("folder");
        let name = nonempty_name(name.as_deref().unwrap_or(default_name), "folder")?;
        let folder = Folder {
            id: uuid::Uuid::new_v4().hyphenated().to_string(),
            name,
            path: canonical_path,
        };
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        registry.folders.push(folder.clone());
        if let Err(error) = registry.save() {
            registry.folders.pop();
            return Err(error);
        }
        Ok(folder)
    }

    /// Create a new project directory inside `settings.projects_dir` and
    /// register it as a folder. The name is a single path segment: rejecting
    /// separators and traversal keeps "create a project" from writing outside
    /// the configured projects directory.
    pub fn create_project(&self, name: String) -> Result<Folder, String> {
        let name = nonempty_name(&name, "project")?;
        if name.contains('/')
            || name.contains('\\')
            || name == "."
            || name == ".."
            || name.starts_with('.')
        {
            return Err(
                "PROJECT_NAME_INVALID: use a plain folder name without path separators".into(),
            );
        }

        let projects_dir = {
            let settings = self.settings.lock().map_err(lock_error)?;
            settings.projects_dir.clone()
        };
        let root = expand_tilde(&projects_dir)?;
        fs::create_dir_all(&root).map_err(|_| {
            "PROJECT_DIR_FAILED: could not create the projects directory".to_string()
        })?;

        let target = root.join(&name);
        if target.exists() {
            return Err("PROJECT_EXISTS: a folder with that name already exists".into());
        }
        fs::create_dir(&target)
            .map_err(|_| "PROJECT_DIR_FAILED: could not create the project folder".to_string())?;

        let path = target
            .to_str()
            .ok_or_else(|| "DIR_PATH_INVALID: project path is not valid UTF-8".to_string())?
            .to_owned();
        self.create_folder(path, Some(name))
    }

    pub fn rename_folder(&self, folder_id: &str, name: String) -> Result<Folder, String> {
        let name = nonempty_name(&name, "folder")?;
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let index = folder_index(&registry, folder_id)?;
        let previous = registry.folders[index].name.clone();
        registry.folders[index].name = name;
        if let Err(error) = registry.save() {
            registry.folders[index].name = previous;
            return Err(error);
        }
        Ok(registry.folders[index].clone())
    }

    pub fn remove_folder(&self, folder_id: &str) -> Result<(), String> {
        let _operation = self.operations.lock().map_err(lock_error)?;
        let session_ids = {
            let registry = self.registry.lock().map_err(lock_error)?;
            folder_index(&registry, folder_id)?;
            registry
                .sessions
                .iter()
                .filter(|session| session.folder_id == folder_id)
                .map(|session| session.id.clone())
                .collect::<Vec<_>>()
        };
        for session_id in &session_ids {
            self.stop_if_live(session_id)?;
        }
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let waiting_before_removal = self.waiting_count();
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let previous_folders = registry.folders.clone();
        let previous_sessions = registry.sessions.clone();
        registry.folders.retain(|folder| folder.id != folder_id);
        registry
            .sessions
            .retain(|session| session.folder_id != folder_id);
        if let Err(error) = registry.save() {
            registry.folders = previous_folders;
            registry.sessions = previous_sessions;
            return Err(error);
        }
        drop(registry);
        let store = self.scrollback_store()?;
        for session_id in &session_ids {
            if store.delete(session_id).is_err() {
                self.events.background_error(
                    "SCROLLBACK_DELETE_FAILED: removed-session scrollback cleanup failed",
                );
            }
        }
        self.publish_attention_if_changed(waiting_before_removal);
        Ok(())
    }

    pub fn launch_session(
        self: &Arc<Self>,
        folder_id: &str,
        tool: Tool,
        title: Option<String>,
        extra_args: Option<Vec<String>>,
    ) -> Result<Session, String> {
        let _operation = self.operations.lock().map_err(lock_error)?;
        let (folder_path, settings) = self.folder_path_and_settings(folder_id)?;
        let now = Utc::now().to_rfc3339();
        let title = match title {
            Some(title) => nonempty_name(&title, "session")?,
            None => default_title(tool, &settings),
        };
        let mut session = Session {
            id: uuid::Uuid::new_v4().hyphenated().to_string(),
            folder_id: folder_id.to_owned(),
            tool,
            title,
            cli_session_id: None,
            status: Status::Stopped,
            model: None,
            extra_args: extra_args.unwrap_or_default(),
            created_at: now.clone(),
            last_active_at: now,
            was_open_in_tab: true,
        };
        let adapter = adapter_for(tool);
        let launched_at = SystemTime::now();
        let (spec, capture) = adapter.launch(&session, &folder_path, &settings)?;
        let spec = self.resolve_spawn_spec(tool, spec, &settings)?;
        if let IdCapture::PreAssigned(id) = &capture {
            session.cli_session_id = Some(id.clone());
        }

        // This synchronous save intentionally precedes spawn. A PTY callback
        // may fire from spawn itself, so dropping the registry lock is equally
        // important to both ordering and deadlock avoidance.
        {
            let _transition = self.mutation.lock().map_err(lock_error)?;
            let mut registry = self.registry.lock().map_err(lock_error)?;
            registry.sessions.push(session.clone());
            if let Err(error) = registry.save() {
                registry.sessions.pop();
                return Err(error);
            }
        }

        if let Err(spawn_error) =
            self.runtime
                .spawn(&session.id, spec, DEFAULT_COLS, DEFAULT_ROWS, &settings)
        {
            self.compensate_failed_launch(&session.id)?;
            return Err(spawn_error);
        }
        if let Err(error) = self.ensure_running_after_spawn(&session.id) {
            let _ = self.runtime.stop(&session.id);
            return Err(error);
        }
        if capture == IdCapture::Discover {
            self.start_discovery(session.id.clone(), folder_path, launched_at, adapter);
        }
        self.session(&session.id)
    }

    pub fn resume_session(self: &Arc<Self>, session_id: &str) -> Result<Session, String> {
        let _operation = self.operations.lock().map_err(lock_error)?;
        let session = self.session(session_id)?;
        if self.runtime.is_live(session_id) {
            return Err("PTY_ALREADY_LIVE: session already has a live PTY".into());
        }
        let folder_path = self.folder_path(&session.folder_id)?;
        let settings = self.get_settings()?;
        let adapter = adapter_for(session.tool);
        let spec = adapter.resume(&session, &folder_path, &settings)?;
        let spec = self.resolve_spawn_spec(session.tool, spec, &settings)?;

        if session.tool == Tool::Terminal && settings.restore_scrollback {
            let saved = self.scrollback_store()?.read(session_id)?;
            if !saved.is_empty() {
                self.events
                    .pty_output(session_id, &format_restored_scrollback(&saved));
            }
        }
        self.runtime
            .spawn(session_id, spec, DEFAULT_COLS, DEFAULT_ROWS, &settings)?;
        if let Err(error) = self.ensure_running_after_spawn(session_id) {
            let _ = self.runtime.stop(session_id);
            return Err(error);
        }
        self.session(session_id)
    }

    pub fn stop_session(&self, session_id: &str) -> Result<(), String> {
        let _operation = self.operations.lock().map_err(lock_error)?;
        self.session(session_id)?;
        self.stop_if_live(session_id)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let _operation = self.operations.lock().map_err(lock_error)?;
        self.session(session_id)?;
        self.stop_if_live(session_id)?;
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let waiting_before_removal = self.waiting_count();
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let previous = registry.sessions.clone();
        registry.sessions.retain(|session| session.id != session_id);
        if let Err(error) = registry.save() {
            registry.sessions = previous;
            return Err(error);
        }
        drop(registry);
        if self.scrollback_store()?.delete(session_id).is_err() {
            self.events.background_error(
                "SCROLLBACK_DELETE_FAILED: removed-session scrollback cleanup failed",
            );
        }
        self.publish_attention_if_changed(waiting_before_removal);
        Ok(())
    }

    pub fn rename_session(&self, session_id: &str, title: String) -> Result<Session, String> {
        let title = nonempty_name(&title, "session")?;
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let index = session_index(&registry, session_id)?;
        let previous = registry.sessions[index].title.clone();
        registry.sessions[index].title = title;
        if let Err(error) = registry.save() {
            registry.sessions[index].title = previous;
            return Err(error);
        }
        Ok(registry.sessions[index].clone())
    }

    pub fn set_tab_open(&self, session_id: &str, open: bool) -> Result<(), String> {
        let _operation = self.operations.lock().map_err(lock_error)?;
        self.session(session_id)?;
        let stop_on_close = self.settings.lock().map_err(lock_error)?.stop_on_close;
        if !open && stop_on_close {
            self.stop_if_live(session_id)?;
        }
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let index = session_index(&registry, session_id)?;
        let previous = registry.sessions[index].was_open_in_tab;
        registry.sessions[index].was_open_in_tab = open;
        if let Err(error) = registry.save() {
            registry.sessions[index].was_open_in_tab = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn write_pty(&self, session_id: &str, data: String) -> Result<(), String> {
        self.session(session_id)?;
        self.runtime.write(session_id, data.as_bytes())
    }

    pub fn resize_pty(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.session(session_id)?;
        self.runtime.resize(session_id, cols, rows)
    }

    /// Resend a live session's recent output. A webview reload destroys every
    /// xterm buffer while the PTYs keep running, so without this the pane for a
    /// still-running CLI comes back blank (SPEC.md §8).
    pub fn replay_output(&self, session_id: &str) -> Result<(), String> {
        self.session(session_id)?;
        self.runtime.replay_output(session_id)
    }

    pub fn get_scrollback(&self, session_id: &str) -> Result<String, String> {
        self.session(session_id)?;
        self.scrollback_store()?.read(session_id)
    }

    pub fn get_settings(&self) -> Result<Settings, String> {
        Ok(self.settings.lock().map_err(lock_error)?.clone())
    }

    pub fn set_settings(&self, settings: Settings) -> Result<Settings, String> {
        crate::settings::validate(&settings)?;
        let _operation = self.operations.lock().map_err(lock_error)?;
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut settings_guard = self.settings.lock().map_err(lock_error)?;
        let old_settings = settings_guard.clone();
        let old_path = expand_tilde(&old_settings.backup_path)?;
        let new_path = expand_tilde(&settings.backup_path)?;

        if old_path != new_path {
            let mut registry = self.registry.lock().map_err(lock_error)?;
            let old_scrollback = ScrollbackStore::new(&old_path);
            let new_scrollback = ScrollbackStore::new(&new_path);
            if new_path.join("registry.json").exists() {
                let target = Registry::load_from_backup_path(&new_path)?.snapshot();
                let mut current = registry.snapshot();
                for session in &mut current.sessions {
                    session.status = Status::Stopped;
                }
                if target != current {
                    return Err(
                        "BACKUP_MIGRATION_CONFLICT: destination contains a different registry"
                            .into(),
                    );
                }
            }
            let mut scrollback_copies = Vec::new();
            for session in &registry.sessions {
                let contents = old_scrollback.read_bytes(&session.id)?;
                let existing = new_scrollback.read_bytes(&session.id)?;
                if !existing.is_empty() && existing != contents {
                    return Err(
                        "BACKUP_MIGRATION_CONFLICT: destination contains different scrollback"
                            .into(),
                    );
                }
                if !contents.is_empty() && existing.is_empty() {
                    scrollback_copies.push((session.id.clone(), contents));
                }
            }
            // Preflight all conflicts before writing. If a later filesystem
            // operation fails, only previously-missing, correct copies remain;
            // the active settings/path are unchanged and retry is idempotent.
            for (session_id, contents) in scrollback_copies {
                new_scrollback.replace(&session_id, &contents)?;
            }
            let mut replacement = Registry::empty(&new_path);
            replacement.folders = registry.folders.clone();
            replacement.sessions = registry.sessions.clone();
            replacement.save()?;
            new_scrollback.prune(settings.retention_days)?;
            self.settings_store.save(&settings)?;
            *registry = replacement;
        } else {
            self.settings_store.save(&settings)?;
        }
        *settings_guard = settings.clone();
        drop(settings_guard);
        let active_scrollback = ScrollbackStore::new(&new_path);
        if active_scrollback.prune(settings.retention_days).is_err() {
            self.events
                .background_error("SCROLLBACK_PRUNE_FAILED: expired scrollback cleanup failed");
        }
        Ok(settings)
    }

    pub fn detect_clis(&self) -> Result<Vec<CliInfo>, String> {
        Ok(detect_all_clis(&self.get_settings()?))
    }

    pub fn export_sessions(&self, to_path: &str) -> Result<(), String> {
        let registry = self.registry.lock().map_err(lock_error)?;
        registry.save()?;
        fs::copy(registry.registry_path(), Path::new(to_path))
            .map_err(|_| "REGISTRY_EXPORT_FAILED: could not write export file".to_string())?;
        Ok(())
    }

    pub fn import_sessions(&self, from_path: &str) -> Result<AppState, String> {
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        registry.import_from(from_path)?;
        Ok(registry.snapshot())
    }

    /// Called by the frontend's explicit `frontend_ready` handshake, which is
    /// sent only after event listeners are installed and state is hydrated, so
    /// restored output and status cannot race listener registration. The atomic
    /// claim makes reloads and repeated ready calls harmless.
    ///
    /// Returns whether this call is the one that started auto-restore.
    pub fn on_frontend_ready(self: &Arc<Self>) -> bool {
        if self.auto_restore_started.swap(true, Ordering::AcqRel) {
            return false;
        }
        let backend = Arc::clone(self);
        thread::spawn(move || backend.restore_open_sessions());
        true
    }

    fn restore_open_sessions(self: &Arc<Self>) {
        let Ok(settings) = self.get_settings() else {
            self.events
                .background_error("SETTINGS_READ_FAILED: auto-restore could not read settings");
            return;
        };
        if !settings.auto_restore {
            return;
        }
        let ids = match self.get_state() {
            Ok(state) => state
                .sessions
                .into_iter()
                .filter(|session| session.was_open_in_tab)
                .map(|session| session.id)
                .collect::<Vec<_>>(),
            Err(_) => {
                self.events.background_error(
                    "REGISTRY_READ_FAILED: auto-restore could not read saved sessions",
                );
                return;
            }
        };
        for id in ids {
            if self.resume_session(&id).is_err() {
                self.events
                    .background_error("AUTO_RESTORE_FAILED: a saved session could not be restored");
            }
        }
    }

    fn handle_pty_event(&self, event: PtyEvent) {
        match event {
            PtyEvent::Output { session_id, data } => {
                let _transition = match self.mutation.lock() {
                    Ok(transition) => transition,
                    Err(_) => {
                        self.events.background_error(
                            "BACKEND_STATE_FAILED: scrollback transition lock failed",
                        );
                        return;
                    }
                };
                let Ok(session) = self.session(&session_id) else {
                    return;
                };
                let is_terminal = session.tool == Tool::Terminal;
                if is_terminal
                    && self
                        .scrollback_store()
                        .and_then(|store| store.append(&session_id, data.as_bytes()))
                        .is_err()
                {
                    self.events.background_error(
                        "SCROLLBACK_WRITE_FAILED: terminal output could not be persisted",
                    );
                }
                self.events.pty_output(&session_id, &data);
            }
            PtyEvent::Status {
                session_id,
                status,
                exit_code,
            } => {
                let _transition = match self.mutation.lock() {
                    Ok(transition) => transition,
                    Err(_) => return,
                };
                let mut changed_waiting = false;
                let mut waiting = 0;
                let mut found = false;
                let mut persistence_failed = false;
                if let Ok(mut registry) = self.registry.lock() {
                    if let Some(session) = registry
                        .sessions
                        .iter_mut()
                        .find(|session| session.id == session_id)
                    {
                        found = true;
                        changed_waiting =
                            (session.status == Status::Waiting) != (status == Status::Waiting);
                        session.status = status;
                        session.last_active_at = Utc::now().to_rfc3339();
                        if registry.save().is_err() {
                            persistence_failed = true;
                        }
                    }
                    waiting = registry
                        .sessions
                        .iter()
                        .filter(|session| session.status == Status::Waiting)
                        .count() as u32;
                }
                if persistence_failed {
                    self.events.background_error(
                        "REGISTRY_WRITE_FAILED: session status could not be persisted",
                    );
                }
                if !found {
                    return;
                }
                self.events.session_status(&session_id, status, exit_code);
                if changed_waiting {
                    let notify = self
                        .settings
                        .lock()
                        .map(|settings| settings.notify_on_waiting && status == Status::Waiting)
                        .unwrap_or(false);
                    self.events.attention_count(waiting, notify);
                }
            }
        }
    }

    fn start_discovery(
        self: &Arc<Self>,
        session_id: String,
        cwd: PathBuf,
        launched_at: SystemTime,
        adapter: Box<dyn crate::adapters::Adapter + Send + Sync>,
    ) {
        #[cfg(test)]
        self.discovery_starts.fetch_add(1, Ordering::AcqRel);
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            let mut elapsed = Duration::ZERO;
            let mut delay = Duration::ZERO;
            loop {
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
                elapsed += delay;
                let Some(backend) = weak.upgrade() else {
                    break;
                };
                if let Ok(Some(id)) = adapter.discover_session_id(&cwd, launched_at) {
                    match backend.persist_discovered_id(&session_id, id) {
                        Ok(Some(session)) => {
                            backend.events.session_updated(&session);
                            break;
                        }
                        Ok(None) => break,
                        Err(_) => backend.events.background_error(
                            "REGISTRY_WRITE_FAILED: discovered session identity could not be persisted",
                        ),
                    }
                }
                // Closing a tab stops its PTY, but the provider may finish
                // writing session metadata just afterward. Keep the initial
                // discovery window alive so that stop cannot strand the saved
                // record without its exact resume key.
                if elapsed >= Duration::from_secs(60) && !backend.runtime.is_live(&session_id) {
                    break;
                }
                delay = next_discovery_delay(elapsed);
            }
        });
    }

    fn persist_discovered_id(
        &self,
        session_id: &str,
        cli_session_id: String,
    ) -> Result<Option<Session>, String> {
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let Some(index) = registry
            .sessions
            .iter()
            .position(|session| session.id == session_id)
        else {
            return Ok(None);
        };
        let previous = registry.sessions[index].cli_session_id.clone();
        registry.sessions[index].cli_session_id = Some(cli_session_id);
        if let Err(error) = registry.save() {
            registry.sessions[index].cli_session_id = previous;
            return Err(error);
        }
        Ok(Some(registry.sessions[index].clone()))
    }

    /// Real PTYs synchronously emit `running` from spawn. The fallback keeps
    /// the command contract correct for alternate runtimes and also protects
    /// against a future PTY implementation that reports asynchronously.
    fn ensure_running_after_spawn(&self, session_id: &str) -> Result<(), String> {
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let index = session_index(&registry, session_id)?;
        if registry.sessions[index].status == Status::Running || !self.runtime.is_live(session_id) {
            return Ok(());
        }
        let previous = registry.sessions[index].clone();
        registry.sessions[index].status = Status::Running;
        registry.sessions[index].last_active_at = Utc::now().to_rfc3339();
        if let Err(error) = registry.save() {
            registry.sessions[index] = previous;
            return Err(error);
        }
        self.events
            .session_status(session_id, Status::Running, None);
        Ok(())
    }

    fn compensate_failed_launch(&self, session_id: &str) -> Result<(), String> {
        let _transition = self.mutation.lock().map_err(lock_error)?;
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let saved = registry.sessions.clone();
        registry
            .sessions
            .retain(|candidate| candidate.id != session_id);
        if registry.save().is_err() {
            registry.sessions = saved;
            self.events.background_error(
                "REGISTRY_WRITE_FAILED: failed PTY launch could not be rolled back",
            );
            return Err(
                "REGISTRY_WRITE_FAILED: PTY launch failed and its saved session could not be rolled back"
                    .into(),
            );
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Session, String> {
        self.registry
            .lock()
            .map_err(lock_error)?
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND: session does not exist".into())
    }

    fn folder_path(&self, folder_id: &str) -> Result<PathBuf, String> {
        let registry = self.registry.lock().map_err(lock_error)?;
        let folder = registry
            .folders
            .iter()
            .find(|folder| folder.id == folder_id)
            .ok_or_else(|| "FOLDER_NOT_FOUND: folder does not exist".to_string())?;
        let path = expand_tilde(&folder.path)?;
        if !path.is_dir() {
            return Err("DIR_NOT_FOUND: session folder no longer exists".into());
        }
        Ok(path)
    }

    fn folder_path_and_settings(&self, folder_id: &str) -> Result<(PathBuf, Settings), String> {
        Ok((self.folder_path(folder_id)?, self.get_settings()?))
    }

    fn scrollback_store(&self) -> Result<ScrollbackStore, String> {
        let settings = self.settings.lock().map_err(lock_error)?;
        Ok(ScrollbackStore::new(expand_tilde(&settings.backup_path)?))
    }

    fn stop_if_live(&self, session_id: &str) -> Result<(), String> {
        if self.runtime.is_live(session_id) {
            self.runtime.stop(session_id)?;
        }
        Ok(())
    }

    fn waiting_count(&self) -> u32 {
        self.registry
            .lock()
            .map(|registry| {
                registry
                    .sessions
                    .iter()
                    .filter(|session| session.status == Status::Waiting)
                    .count() as u32
            })
            .unwrap_or(0)
    }

    fn publish_attention_if_changed(&self, previous: u32) {
        let waiting = self.waiting_count();
        if waiting != previous {
            self.events.attention_count(waiting, false);
        }
    }

    fn resolve_spawn_spec(
        &self,
        tool: Tool,
        spec: SpawnSpec,
        settings: &Settings,
    ) -> Result<SpawnSpec, String> {
        if !self.enforce_executable_checks {
            return Ok(spec);
        }
        let path = effective_search_path(settings);
        resolve_spawn_spec_with_environment(
            tool,
            spec,
            path.as_deref(),
            dirs::home_dir().as_deref(),
        )
    }
}

fn next_discovery_delay(elapsed: Duration) -> Duration {
    if elapsed.is_zero() {
        Duration::from_secs(1)
    } else if elapsed < Duration::from_secs(3) {
        Duration::from_secs(2)
    } else if elapsed < Duration::from_secs(60) {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(30)
    }
}

fn folder_index(registry: &Registry, id: &str) -> Result<usize, String> {
    registry
        .folders
        .iter()
        .position(|folder| folder.id == id)
        .ok_or_else(|| "FOLDER_NOT_FOUND: folder does not exist".into())
}

fn session_index(registry: &Registry, id: &str) -> Result<usize, String> {
    registry
        .sessions
        .iter()
        .position(|session| session.id == id)
        .ok_or_else(|| "SESSION_NOT_FOUND: session does not exist".into())
}

fn nonempty_name(value: &str, kind: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("NAME_INVALID: {kind} name cannot be empty"))
    } else {
        Ok(value.to_owned())
    }
}

fn default_title(tool: Tool, settings: &Settings) -> String {
    match tool {
        Tool::Claude => "new Claude session".into(),
        Tool::Codex => "new Codex session".into(),
        Tool::Copilot => "new Copilot session".into(),
        Tool::Opencode => "new opencode session".into(),
        Tool::Terminal => Path::new(&settings.shell)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("terminal")
            .to_owned(),
    }
}

fn tool_display_name(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude => "claude",
        Tool::Codex => "codex",
        Tool::Copilot => "copilot",
        Tool::Opencode => "opencode",
        Tool::Terminal => "configured shell",
    }
}

fn detect_all_clis(settings: &Settings) -> Vec<CliInfo> {
    let path = effective_search_path(settings);
    let home = dirs::home_dir();
    [
        (Tool::Claude, "claude"),
        (Tool::Codex, "codex"),
        (Tool::Copilot, "copilot"),
        (Tool::Opencode, "opencode"),
    ]
    .into_iter()
    .map(|(tool, program)| detect_cli(tool, program, path.as_deref(), home.as_deref()))
    .chain(std::iter::once(detect_shell(
        &settings.shell,
        path.as_deref(),
        home.as_deref(),
    )))
    .collect()
}

fn detect_cli(
    tool: Tool,
    program: &str,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
) -> CliInfo {
    let path = find_executable_with_environment(program, search_path, home);
    let version = path.as_deref().and_then(bounded_version);
    CliInfo {
        tool,
        found: path.is_some(),
        version,
        path: path.map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(unix)]
const VERSION_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(unix)]
const VERSION_OUTPUT_LIMIT: usize = 4096;

/// `std::process::Command` starts a Windows child before it can be assigned to
/// a kill-on-close Job Object. That assignment race can leak descendants, so
/// v1 conservatively reports an installed Windows CLI with an unknown version
/// instead of spawning an uncontained process.
#[cfg(windows)]
fn bounded_version(_path: &Path) -> Option<String> {
    debug_assert!(!supports_contained_version_probe(true));
    None
}

#[cfg(unix)]
fn bounded_version(path: &Path) -> Option<String> {
    debug_assert!(supports_contained_version_probe(false));
    let mut stdout_file = tempfile::NamedTempFile::new().ok()?;
    let mut stderr_file = tempfile::NamedTempFile::new().ok()?;
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdout(Stdio::from(stdout_file.reopen().ok()?))
        .stderr(Stdio::from(stderr_file.reopen().ok()?));
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command.spawn().ok()?;
    let deadline = std::time::Instant::now() + VERSION_TIMEOUT;
    let successful = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                terminate_version_process(&mut child);
                let _ = child.wait();
                break false;
            }
        }
    };
    // A nominally successful Unix CLI may leave descendants alive. Kill its
    // isolated process group; regular-file capture keeps the final read capped
    // and independent of pipe EOF behavior.
    terminate_version_process(&mut child);
    if !successful {
        return None;
    }
    let stdout = read_capped_file(stdout_file.as_file_mut())?;
    let stderr = read_capped_file(stderr_file.as_file_mut())?;
    let bytes = if stdout.is_empty() { stderr } else { stdout };
    let text = String::from_utf8_lossy(&bytes).trim().to_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(unix)]
fn terminate_version_process(child: &mut std::process::Child) {
    unsafe {
        let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
}

#[cfg(unix)]
fn read_capped_file(file: &mut fs::File) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut captured = Vec::new();
    file.take(VERSION_OUTPUT_LIMIT as u64)
        .read_to_end(&mut captured)
        .ok()?;
    Some(captured)
}

fn supports_contained_version_probe(windows: bool) -> bool {
    !windows
}

fn detect_shell(shell: &str, search_path: Option<&OsStr>, home: Option<&Path>) -> CliInfo {
    let path = find_executable_with_environment(shell, search_path, home).or_else(|| {
        let path = PathBuf::from(shell);
        path.is_file().then_some(path)
    });
    CliInfo {
        tool: Tool::Terminal,
        found: path.is_some(),
        version: None,
        path: path.map(|path| path.to_string_lossy().into_owned()),
    }
}

fn effective_search_path(settings: &Settings) -> Option<OsString> {
    settings
        .env_vars
        .iter()
        .rev()
        .find(|env| is_path_key(&env.key))
        .map(|env| OsString::from(&env.value))
        .or_else(|| std::env::var_os("PATH"))
}

#[cfg(windows)]
fn is_path_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("PATH")
}

#[cfg(not(windows))]
fn is_path_key(key: &str) -> bool {
    key == "PATH"
}

fn resolve_spawn_spec_with_environment(
    tool: Tool,
    mut spec: SpawnSpec,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
) -> Result<SpawnSpec, String> {
    let executable = find_executable_with_environment(&spec.program, search_path, home)
        .ok_or_else(|| {
            format!(
                "CLI_NOT_FOUND: {} is not installed",
                tool_display_name(tool)
            )
        })?;

    // Preflight and PTY launch must use one resolved file. Passing the bare
    // command would make portable-pty perform a second PATH lookup that can
    // disagree with detection after a desktop-app restart.
    spec.program = executable.to_string_lossy().into_owned();
    Ok(spec)
}

fn find_executable_with_environment(
    program: &str,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let candidate = Path::new(program);
    if candidate.components().count() > 1 {
        return is_executable(candidate).then(|| candidate.to_path_buf());
    }

    executable_search_directories(search_path, home)
        .into_iter()
        .flat_map(|directory| executable_candidates(&directory, program))
        .find(|candidate| is_executable(candidate))
}

fn executable_search_directories(search_path: Option<&OsStr>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut directories = search_path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    let mut add = |directory: PathBuf| {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    };

    if let Some(home) = home {
        // Desktop launchers often omit user-level package-manager bins from
        // PATH. These locations cover the supported CLIs without invoking a
        // login shell or executing user startup files during detection.
        for relative in [
            ".local/bin",
            ".opencode/bin",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
            ".npm-global/bin",
        ] {
            add(home.join(relative));
        }

        let nvm_nodes = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_nodes) {
            let mut version_bins = entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    entry
                        .file_type()
                        .ok()
                        .filter(|kind| kind.is_dir())
                        .map(|_| entry.path().join("bin"))
                })
                .collect::<Vec<_>>();
            version_bins.sort_by(|left, right| right.cmp(left));
            for directory in version_bins {
                add(directory);
            }
        }

        #[cfg(windows)]
        for relative in [
            "AppData/Roaming/npm",
            "AppData/Local/Microsoft/WinGet/Links",
        ] {
            add(home.join(relative));
        }
    }

    #[cfg(unix)]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin"] {
        add(PathBuf::from(directory));
    }

    directories
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn executable_candidates(directory: &Path, program: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let extensions = std::env::var_os("PATHEXT")
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
        let mut candidates = vec![directory.join(program)];
        candidates.extend(
            extensions
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(|extension| directory.join(format!("{program}{extension}"))),
        );
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![directory.join(program)]
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "BACKEND_STATE_FAILED: internal state lock is unavailable".into()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::field_reassign_with_default)]
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::AtomicU64;
    use std::time::Instant;
    use tempfile::tempdir;

    #[derive(Default)]
    struct FakeRuntime {
        live: Mutex<HashSet<String>>,
        spawns: Mutex<Vec<(String, SpawnSpec)>>,
        registry_path: Mutex<Option<PathBuf>>,
        saw_persisted_identity: Mutex<bool>,
        exit_immediately: AtomicBool,
        fail_stop: AtomicBool,
        fail_spawn: AtomicBool,
        stop_calls: AtomicUsize,
        replays: Mutex<Vec<String>>,
        /// Milliseconds `stop` should wait, standing in for the graceful window.
        stop_delay_ms: AtomicU64,
        /// Set once a delayed `stop` is actually in flight.
        stopping: AtomicBool,
    }

    impl PtyRuntime for FakeRuntime {
        fn spawn(
            &self,
            session_id: &str,
            spec: SpawnSpec,
            _cols: u16,
            _rows: u16,
            _settings: &Settings,
        ) -> Result<(), String> {
            if let Some(path) = self.registry_path.lock().unwrap().clone() {
                let raw = fs::read_to_string(path).unwrap();
                let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
                *self.saw_persisted_identity.lock().unwrap() =
                    value["sessions"].as_array().unwrap().iter().any(|session| {
                        session["id"] == session_id && !session["cliSessionId"].is_null()
                    });
            }
            if self.fail_spawn.load(Ordering::Acquire) {
                return Err("PTY_SPAWN_FAILED: synthetic spawn failure".into());
            }
            if !self.exit_immediately.load(Ordering::Acquire) {
                self.live.lock().unwrap().insert(session_id.to_owned());
            }
            self.spawns
                .lock()
                .unwrap()
                .push((session_id.to_owned(), spec));
            Ok(())
        }

        fn write(&self, session_id: &str, _data: &[u8]) -> Result<(), String> {
            self.live(session_id)
        }
        fn resize(&self, session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            self.live(session_id)
        }
        fn stop(&self, session_id: &str) -> Result<(), String> {
            self.stop_calls.fetch_add(1, Ordering::AcqRel);
            // Stand in for the real graceful-stop window, so a test can hold a
            // close open and watch what else it blocks.
            let delay = self.stop_delay_ms.load(Ordering::Acquire);
            if delay > 0 {
                self.stopping.store(true, Ordering::Release);
                thread::sleep(Duration::from_millis(delay));
            }
            if self.fail_stop.load(Ordering::Acquire) {
                return Err("PTY_STOP_FAILED: synthetic stop failure".into());
            }
            self.live.lock().unwrap().remove(session_id);
            Ok(())
        }
        fn replay_output(&self, session_id: &str) -> Result<(), String> {
            self.replays.lock().unwrap().push(session_id.to_owned());
            Ok(())
        }
        fn is_live(&self, session_id: &str) -> bool {
            self.live.lock().unwrap().contains(session_id)
        }
    }

    impl FakeRuntime {
        fn live(&self, id: &str) -> Result<(), String> {
            self.is_live(id)
                .then_some(())
                .ok_or_else(|| "PTY_NOT_FOUND: no live PTY for session".into())
        }
    }

    struct AlwaysDiscovers(&'static str);

    impl crate::adapters::Adapter for AlwaysDiscovers {
        fn tool(&self) -> Tool {
            Tool::Codex
        }

        fn launch(
            &self,
            _session: &Session,
            _cwd: &Path,
            _settings: &Settings,
        ) -> Result<(SpawnSpec, IdCapture), String> {
            unreachable!("discovery test adapter never launches")
        }

        fn resume(
            &self,
            _session: &Session,
            _cwd: &Path,
            _settings: &Settings,
        ) -> Result<SpawnSpec, String> {
            unreachable!("discovery test adapter never resumes")
        }

        fn discover_session_id(
            &self,
            _cwd: &Path,
            _launched_at: SystemTime,
        ) -> Result<Option<String>, String> {
            Ok(Some(self.0.to_owned()))
        }
    }

    #[derive(Default)]
    struct TestEvents {
        outputs: Mutex<Vec<String>>,
        statuses: Mutex<Vec<Status>>,
        attention: Mutex<Vec<u32>>,
        updated: Mutex<Vec<Session>>,
        errors: Mutex<Vec<String>>,
    }

    impl BackendEvents for TestEvents {
        fn pty_output(&self, _session_id: &str, data: &str) {
            self.outputs.lock().unwrap().push(data.into());
        }

        fn session_status(&self, _session_id: &str, status: Status, _exit_code: Option<i32>) {
            self.statuses.lock().unwrap().push(status);
        }

        fn session_updated(&self, session: &Session) {
            self.updated.lock().unwrap().push(session.clone());
        }

        fn attention_count(&self, waiting: u32, _notify: bool) {
            self.attention.lock().unwrap().push(waiting);
        }

        fn background_error(&self, message: &str) {
            self.errors.lock().unwrap().push(message.into());
        }
    }

    fn harness() -> (tempfile::TempDir, Arc<Backend>, Arc<FakeRuntime>) {
        let root = tempdir().unwrap();
        let backup = root.path().join("backup");
        let settings_path = root.path().join("config/settings.json");
        let mut settings = Settings::default();
        settings.backup_path = backup.to_string_lossy().into_owned();
        settings.shell = if cfg!(windows) {
            "cmd.exe".into()
        } else {
            "/bin/sh".into()
        };
        let store = SettingsStore::new(settings_path);
        store.save(&settings).unwrap();
        let registry = Registry::empty(&backup);
        let runtime = Arc::new(FakeRuntime::default());
        *runtime.registry_path.lock().unwrap() = Some(backup.join("registry.json"));
        let backend = Backend::for_test(
            store,
            settings,
            registry,
            runtime.clone(),
            Arc::new(NoopEvents),
        );
        (root, backend, runtime)
    }

    #[test]
    fn folder_mutations_validate_and_persist() {
        let (root, backend, _) = harness();
        assert!(backend
            .create_folder(root.path().join("missing").to_string_lossy().into(), None)
            .unwrap_err()
            .starts_with("DIR_NOT_FOUND:"));
        let path = root.path().join("synthetic-project");
        fs::create_dir(&path).unwrap();
        let folder = backend
            .create_folder(path.to_string_lossy().into(), None)
            .unwrap();
        assert_eq!(folder.name, "synthetic-project");
        assert_eq!(
            backend
                .rename_folder(&folder.id, "renamed".into())
                .unwrap()
                .name,
            "renamed"
        );
        backend.remove_folder(&folder.id).unwrap();
        assert!(backend.get_state().unwrap().folders.is_empty());
        assert!(backend.rename_folder(&folder.id, "x".into()).is_err());
    }

    #[test]
    fn create_project_rejects_names_that_would_escape_the_projects_directory() {
        let (root, backend, _) = harness();
        let projects = root.path().join("projects");
        {
            let mut settings = backend.settings.lock().unwrap();
            settings.projects_dir = projects.to_str().unwrap().to_owned();
        }

        // Anything that is not a single plain segment must be refused, so a
        // project can never be created outside the configured directory.
        for name in ["../escape", "nested/child", "..", ".", ".hidden", "  "] {
            assert!(
                backend.create_project(name.into()).is_err(),
                "expected {name:?} to be rejected"
            );
        }
        assert!(backend.get_state().unwrap().folders.is_empty());
    }

    #[test]
    fn create_project_creates_the_directory_and_registers_it() {
        let (root, backend, _) = harness();
        let projects = root.path().join("projects");
        {
            let mut settings = backend.settings.lock().unwrap();
            settings.projects_dir = projects.to_str().unwrap().to_owned();
        }

        let folder = backend.create_project("demo-project".into()).unwrap();

        assert!(projects.join("demo-project").is_dir());
        assert_eq!(folder.name, "demo-project");
        assert_eq!(backend.get_state().unwrap().folders.len(), 1);
        // A second project with the same name must not clobber the first.
        assert!(backend.create_project("demo-project".into()).is_err());
    }

    #[test]
    fn create_folder_persists_a_canonical_absolute_path() {
        let (_root, backend, _) = harness();

        let folder = backend
            .create_folder(".".into(), Some("current".into()))
            .unwrap();
        let expected = fs::canonicalize(".").unwrap();

        assert!(Path::new(&folder.path).is_absolute());
        assert_eq!(Path::new(&folder.path), expected);
        assert_eq!(backend.get_state().unwrap().folders[0].path, folder.path);
    }

    #[test]
    fn launch_persists_preassigned_identity_before_spawn_and_reopens_empty_identity() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let launched = backend
            .launch_session(&folder.id, Tool::Claude, None, None)
            .unwrap();
        assert!(launched.cli_session_id.is_some());
        assert!(*runtime.saw_persisted_identity.lock().unwrap());
        backend.stop_session(&launched.id).unwrap();
        backend.resume_session(&launched.id).unwrap();
        let spawns = runtime.spawns.lock().unwrap();
        assert_eq!(
            spawns[1].1.args,
            vec!["--session-id", launched.cli_session_id.as_ref().unwrap()]
        );
    }

    #[test]
    fn spawn_failure_compensates_persisted_session_record() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        runtime.fail_spawn.store(true, Ordering::Release);

        let error = backend
            .launch_session(&folder.id, Tool::Claude, None, None)
            .unwrap_err();

        assert!(error.starts_with("PTY_SPAWN_FAILED:"));
        assert!(backend.get_state().unwrap().sessions.is_empty());
        let settings = backend.get_settings().unwrap();
        let persisted =
            Registry::load_from_backup_path(expand_tilde(&settings.backup_path).unwrap()).unwrap();
        assert!(persisted.sessions.is_empty());
        assert!(*runtime.saw_persisted_identity.lock().unwrap());
    }

    #[test]
    fn failed_spawn_compensation_keeps_record_and_surfaces_combined_error() {
        let root = tempdir().unwrap();
        let blocked = root.path().join("registry-parent-file");
        fs::write(&blocked, b"not a directory").unwrap();
        let folder_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let session_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let mut registry = Registry::empty(blocked.join("nested"));
        registry.folders.push(Folder {
            id: folder_id.clone(),
            name: "synthetic".into(),
            path: root.path().to_string_lossy().into_owned(),
        });
        registry.sessions.push(Session {
            id: session_id.clone(),
            folder_id,
            tool: Tool::Claude,
            title: "synthetic".into(),
            cli_session_id: Some("synthetic-id".into()),
            status: Status::Stopped,
            model: None,
            extra_args: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
            last_active_at: Utc::now().to_rfc3339(),
            was_open_in_tab: true,
        });
        let events = Arc::new(TestEvents::default());
        let backend = Backend::for_test(
            SettingsStore::new(root.path().join("settings.json")),
            Settings {
                backup_path: root
                    .path()
                    .join("scrollback")
                    .to_string_lossy()
                    .into_owned(),
                ..Settings::default()
            },
            registry,
            Arc::new(FakeRuntime::default()),
            events.clone(),
        );

        let error = backend.compensate_failed_launch(&session_id).unwrap_err();
        assert!(error.starts_with("REGISTRY_WRITE_FAILED:"));
        assert!(backend.session(&session_id).is_ok());
        assert_eq!(events.errors.lock().unwrap().len(), 1);
    }

    #[test]
    fn session_mutations_tab_close_and_unknown_ids_are_handled() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        assert_eq!(
            backend
                .rename_session(&session.id, "shell".into())
                .unwrap()
                .title,
            "shell"
        );
        // Closing a running tab is one lifecycle command that stops the PTY
        // exactly once and persists the closed state; the frontend must not
        // also send stop_session.
        backend.set_tab_open(&session.id, false).unwrap();
        assert!(!runtime.is_live(&session.id));
        assert_eq!(runtime.stop_calls.load(Ordering::Acquire), 1);
        assert!(!backend.session(&session.id).unwrap().was_open_in_tab);
        backend.delete_session(&session.id).unwrap();
        assert!(backend.stop_session(&session.id).is_err());
        assert!(backend.delete_session(&session.id).is_err());
    }

    #[test]
    fn a_slow_close_does_not_block_what_the_window_reads() {
        // Closing a tab waits out the PTY's graceful-stop window — up to five
        // seconds, deliberately. That wait is correct, but if it held anything
        // the UI reads to stay drawn, the window would beachball for the whole
        // timeout, which is the macOS spinner this design exists to avoid.
        // Reads must stay off the `operations` lock (SPEC.md §8).
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();

        runtime.stop_delay_ms.store(1_500, Ordering::Release);
        let closing = {
            let backend = Arc::clone(&backend);
            let id = session.id.clone();
            thread::spawn(move || backend.set_tab_open(&id, false))
        };

        // Wait for the stop to actually be in flight, so the reads below are
        // genuinely racing it rather than landing before or after.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !runtime.stopping.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "stop never started");
            thread::sleep(Duration::from_millis(5));
        }

        let started = Instant::now();
        backend.get_state().unwrap();
        backend.get_settings().unwrap();
        backend.session(&session.id).unwrap();
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(500),
            "reads waited {elapsed:?} behind an in-flight close; the window would hang"
        );
        assert!(closing.join().unwrap().is_ok());
        assert_eq!(runtime.stop_calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn replay_output_reaches_the_runtime_only_for_known_sessions() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();

        backend.replay_output(&session.id).unwrap();

        assert_eq!(*runtime.replays.lock().unwrap(), vec![session.id.clone()]);
        assert!(backend.replay_output("missing").is_err());
        assert_eq!(runtime.replays.lock().unwrap().len(), 1);
    }

    #[test]
    fn terminal_resume_emits_saved_scrollback_before_spawn() {
        #[derive(Default)]
        struct CaptureEvents(Mutex<Vec<String>>);
        impl BackendEvents for CaptureEvents {
            fn pty_output(&self, _session_id: &str, data: &str) {
                self.0.lock().unwrap().push(data.into());
            }
        }
        let (root, original, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = original
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = original
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        original.stop_session(&session.id).unwrap();
        original
            .scrollback_store()
            .unwrap()
            .append(&session.id, b"one\ntwo\n")
            .unwrap();
        let events = Arc::new(CaptureEvents::default());
        let settings = original.get_settings().unwrap();
        let registry =
            Registry::load_from_backup_path(expand_tilde(&settings.backup_path).unwrap()).unwrap();
        let backend = Backend::for_test(
            SettingsStore::new(root.path().join("config/settings.json")),
            settings,
            registry,
            runtime,
            events.clone(),
        );
        backend.resume_session(&session.id).unwrap();
        assert!(events.0.lock().unwrap()[0].contains("scrollback recovered (2 lines)"));
    }

    #[test]
    fn settings_export_and_merge_import_round_trip() {
        let (root, backend, _) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        backend
            .create_folder(project.to_string_lossy().into(), Some("one".into()))
            .unwrap();
        let export = root.path().join("export.json");
        backend.export_sessions(export.to_str().unwrap()).unwrap();
        let second = root.path().join("second");
        fs::create_dir(&second).unwrap();
        backend
            .create_folder(second.to_string_lossy().into(), Some("two".into()))
            .unwrap();
        let state = backend.import_sessions(export.to_str().unwrap()).unwrap();
        assert_eq!(state.folders.len(), 2);
        let mut settings = backend.get_settings().unwrap();
        settings.theme = "nebula".into();
        assert_eq!(backend.set_settings(settings.clone()).unwrap(), settings);
    }

    #[test]
    fn cli_detection_has_exact_five_tool_rows() {
        let (_, backend, _) = harness();
        let rows = backend.detect_clis().unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(
            rows.iter().filter(|row| row.tool == Tool::Terminal).count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn cli_resolution_recovers_common_user_installs_missing_from_process_path() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let home = root.path().join("home");
        let installs = [
            ("claude", home.join(".local/bin/claude")),
            ("copilot", home.join(".local/bin/copilot")),
            ("opencode", home.join(".opencode/bin/opencode")),
            ("codex", home.join(".nvm/versions/node/v24.0.0/bin/codex")),
        ];
        for (_, executable) in &installs {
            fs::create_dir_all(executable.parent().unwrap()).unwrap();
            fs::write(executable, b"#!/bin/sh\nexit 0\n").unwrap();
            let mut permissions = fs::metadata(executable).unwrap().permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(executable, permissions).unwrap();
        }
        let restricted_path = std::ffi::OsStr::new("/usr/bin:/bin");

        for (program, expected) in installs {
            assert_eq!(
                find_executable_with_environment(program, Some(restricted_path), Some(&home)),
                Some(expected),
                "{program} should be found outside the inherited GUI PATH"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolved_spawn_spec_uses_the_exact_executable_found_by_preflight() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let home = root.path().join("home");
        let executable = home.join(".nvm/versions/node/v24.0.0/bin/codex");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let original = SpawnSpec::new("codex", ["resume", "synthetic-session-id"], root.path());

        let resolved = resolve_spawn_spec_with_environment(
            Tool::Codex,
            original,
            Some(std::ffi::OsStr::new("/usr/bin:/bin")),
            Some(&home),
        )
        .unwrap();

        assert_eq!(Path::new(&resolved.program), executable);
        assert_eq!(resolved.args, vec!["resume", "synthetic-session-id"]);
    }

    #[test]
    fn pty_status_and_discovered_identity_are_synchronously_persisted() {
        let (root, backend, _) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Codex, None, None)
            .unwrap();

        backend.handle_pty_event(PtyEvent::Status {
            session_id: session.id.clone(),
            status: Status::Waiting,
            exit_code: None,
        });
        backend
            .persist_discovered_id(&session.id, "synthetic-cli-id".into())
            .unwrap();

        let settings = backend.get_settings().unwrap();
        let loaded =
            Registry::load_from_backup_path(expand_tilde(&settings.backup_path).unwrap()).unwrap();
        let persisted = loaded
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        // Registry load intentionally normalizes runtime status on boot, so
        // inspect raw JSON for synchronous status persistence.
        let raw = fs::read_to_string(loaded.registry_path()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["sessions"][0]["status"], "waiting");
        assert_eq!(
            persisted.cli_session_id.as_deref(),
            Some("synthetic-cli-id")
        );
    }

    #[test]
    fn fast_exit_is_not_overwritten_by_running_fallback() {
        let (root, backend, runtime) = harness();
        runtime.exit_immediately.store(true, Ordering::Release);
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();

        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();

        assert_eq!(session.status, Status::Stopped);
    }

    #[cfg(unix)]
    #[test]
    fn real_fast_exit_preserves_running_then_stopped_callback_order() {
        let root = tempdir().unwrap();
        let backup = root.path().join("backup");
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let mut settings = Settings::default();
        settings.backup_path = backup.to_string_lossy().into_owned();
        settings.shell = "/bin/sh".into();
        let store = SettingsStore::new(root.path().join("settings.json"));
        store.save(&settings).unwrap();
        let mut registry = Registry::empty(&backup);
        let folder = Folder {
            id: uuid::Uuid::new_v4().hyphenated().to_string(),
            name: "project".into(),
            path: project.to_string_lossy().into_owned(),
        };
        registry.folders.push(folder.clone());
        registry.save().unwrap();
        let events = Arc::new(TestEvents::default());
        let backend = Backend::for_test_real(store, settings, registry, events.clone());

        let session = backend
            .launch_session(
                &folder.id,
                Tool::Terminal,
                None,
                Some(vec!["-c".into(), "exit 0".into()]),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while backend.session(&session.id).unwrap().status != Status::Stopped
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }

        let statuses = events.statuses.lock().unwrap().clone();
        assert_eq!(statuses.first(), Some(&Status::Running));
        assert_eq!(statuses.last(), Some(&Status::Stopped));
        assert_eq!(
            backend.session(&session.id).unwrap().status,
            Status::Stopped
        );
    }

    #[test]
    fn background_persistence_failures_keep_runtime_truth_and_are_user_visible() {
        let root = tempdir().unwrap();
        let blocked_backup = root.path().join("backup-is-a-file");
        fs::write(&blocked_backup, b"synthetic blocker").unwrap();
        let mut settings = Settings::default();
        settings.backup_path = blocked_backup.to_string_lossy().into_owned();
        let folder_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let session_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let mut registry = Registry::empty(blocked_backup.join("nested"));
        registry.folders.push(Folder {
            id: folder_id.clone(),
            name: "synthetic".into(),
            path: root.path().to_string_lossy().into_owned(),
        });
        registry.sessions.push(Session {
            id: session_id.clone(),
            folder_id,
            tool: Tool::Terminal,
            title: "synthetic".into(),
            cli_session_id: None,
            status: Status::Stopped,
            model: None,
            extra_args: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
            last_active_at: Utc::now().to_rfc3339(),
            was_open_in_tab: false,
        });
        let events = Arc::new(TestEvents::default());
        let backend = Backend::for_test(
            SettingsStore::new(root.path().join("settings.json")),
            settings,
            registry,
            Arc::new(FakeRuntime::default()),
            events.clone(),
        );

        backend.handle_pty_event(PtyEvent::Status {
            session_id: session_id.clone(),
            status: Status::Waiting,
            exit_code: None,
        });
        backend.handle_pty_event(PtyEvent::Output {
            session_id: session_id.clone(),
            data: "synthetic output".into(),
        });
        backend.handle_pty_event(PtyEvent::Status {
            session_id: session_id.clone(),
            status: Status::Stopped,
            exit_code: Some(17),
        });
        assert!(backend
            .persist_discovered_id(&session_id, "synthetic-cli-id".into())
            .is_err());

        let session = backend.session(&session_id).unwrap();
        assert_eq!(session.status, Status::Stopped);
        assert_eq!(session.cli_session_id, None);
        assert_eq!(
            events.statuses.lock().unwrap().as_slice(),
            &[Status::Waiting, Status::Stopped]
        );
        assert_eq!(events.attention.lock().unwrap().as_slice(), &[1, 0]);
        assert_eq!(events.outputs.lock().unwrap().len(), 1);
        assert_eq!(events.errors.lock().unwrap().len(), 3);
    }

    #[test]
    fn discovery_backoff_and_failed_identity_save_remain_retryable() {
        assert_eq!(
            next_discovery_delay(Duration::from_secs(1)),
            Duration::from_secs(2)
        );
        assert_eq!(
            next_discovery_delay(Duration::from_secs(3)),
            Duration::from_secs(5)
        );
        assert_eq!(
            next_discovery_delay(Duration::from_secs(59)),
            Duration::from_secs(5)
        );
        assert_eq!(
            next_discovery_delay(Duration::from_secs(60)),
            Duration::from_secs(30)
        );
        // The background persistence failure test proves a failed identity
        // save leaves cliSessionId unset; the loop in
        // start_discovery only breaks on Ok(Some), so the next delay retries it.
    }

    #[test]
    fn discovery_persists_identity_after_the_tab_stops_its_pty() {
        let (root, backend, _) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();

        backend.start_discovery(
            session.id.clone(),
            project,
            SystemTime::now(),
            Box::new(AlwaysDiscovers("synthetic-cli-id")),
        );
        backend.stop_session(&session.id).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while backend
            .session(&session.id)
            .unwrap()
            .cli_session_id
            .is_none()
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(
            backend
                .session(&session.id)
                .unwrap()
                .cli_session_id
                .as_deref(),
            Some("synthetic-cli-id")
        );
        let settings = backend.get_settings().unwrap();
        let persisted =
            Registry::load_from_backup_path(expand_tilde(&settings.backup_path).unwrap()).unwrap();
        assert_eq!(
            persisted.sessions[0].cli_session_id.as_deref(),
            Some("synthetic-cli-id")
        );
    }

    #[test]
    fn missing_discovered_identity_never_spawns_a_provider_picker() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();

        for tool in [Tool::Codex, Tool::Opencode] {
            let session = backend
                .launch_session(&folder.id, tool, None, None)
                .unwrap();
            backend.stop_session(&session.id).unwrap();
            let spawn_count = runtime.spawns.lock().unwrap().len();

            assert!(backend
                .resume_session(&session.id)
                .unwrap_err()
                .starts_with("SESSION_ID_UNAVAILABLE:"));
            assert_eq!(runtime.spawns.lock().unwrap().len(), spawn_count);
            assert!(!backend.runtime.is_live(&session.id));
        }

        let spawns = runtime.spawns.lock().unwrap();
        assert_eq!(spawns.len(), 2);
        assert_eq!(backend.discovery_starts.load(Ordering::Acquire), 2);
    }

    #[test]
    fn deleting_or_removing_waiting_sessions_publishes_zero_attention() {
        let (root, original, runtime) = harness();
        let settings = original.get_settings().unwrap();
        let registry = Registry::empty(expand_tilde(&settings.backup_path).unwrap());
        let events = Arc::new(TestEvents::default());
        let backend = Backend::for_test(
            SettingsStore::new(root.path().join("config/settings.json")),
            settings,
            registry,
            runtime,
            events.clone(),
        );
        for operation in ["delete", "remove"] {
            let project = root.path().join(operation);
            fs::create_dir(&project).unwrap();
            let folder = backend
                .create_folder(project.to_string_lossy().into(), None)
                .unwrap();
            let session = backend
                .launch_session(&folder.id, Tool::Terminal, None, None)
                .unwrap();
            backend.handle_pty_event(PtyEvent::Status {
                session_id: session.id.clone(),
                status: Status::Waiting,
                exit_code: None,
            });
            if operation == "delete" {
                backend.delete_session(&session.id).unwrap();
                backend.remove_folder(&folder.id).unwrap();
            } else {
                backend.remove_folder(&folder.id).unwrap();
            }
            assert_eq!(events.attention.lock().unwrap().last(), Some(&0));
            backend.handle_pty_event(PtyEvent::Status {
                session_id: session.id,
                status: Status::Stopped,
                exit_code: Some(0),
            });
            assert_eq!(events.attention.lock().unwrap().last(), Some(&0));
        }
    }

    #[test]
    fn auto_restore_runs_after_frontend_ready_once_and_surfaces_restore_errors() {
        let (root, original, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = original
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = original
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        original.stop_session(&session.id).unwrap();
        original.handle_pty_event(PtyEvent::Status {
            session_id: session.id.clone(),
            status: Status::Stopped,
            exit_code: Some(0),
        });
        let settings = original.get_settings().unwrap();
        let registry =
            Registry::load_from_backup_path(expand_tilde(&settings.backup_path).unwrap()).unwrap();
        let events = Arc::new(TestEvents::default());
        let backend = Backend::for_test(
            SettingsStore::new(root.path().join("config/settings.json")),
            settings,
            registry,
            runtime,
            events.clone(),
        );

        backend.restore_open_sessions();
        assert!(backend.runtime.is_live(&session.id));
        backend.stop_session(&session.id).unwrap();
        {
            let mut registry = backend.registry.lock().unwrap();
            registry.folders[0].path = root
                .path()
                .join("missing-project")
                .to_string_lossy()
                .into_owned();
            registry.sessions[0].status = Status::Stopped;
            registry.save().unwrap();
        }
        backend.restore_open_sessions();
        assert!(events
            .errors
            .lock()
            .unwrap()
            .iter()
            .any(|error| error.starts_with("AUTO_RESTORE_FAILED:")));
        // Only the first ready call claims the guard, so a reload or a repeated
        // handshake cannot restore the same sessions twice.
        assert!(backend.on_frontend_ready());
        assert!(!backend.on_frontend_ready());
        assert!(backend.auto_restore_started.load(Ordering::Acquire));
    }

    #[test]
    fn settings_transition_serializes_registry_mutation_and_migrates_scrollback() {
        let (root, backend, _) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        backend.stop_session(&session.id).unwrap();
        backend
            .scrollback_store()
            .unwrap()
            .replace(&session.id, b"synthetic transcript\n\xff")
            .unwrap();

        let barrier = Arc::new(std::sync::Barrier::new(3));
        let new_backup = root.path().join("new-backup");
        let settings_backend = Arc::clone(&backend);
        let settings_barrier = Arc::clone(&barrier);
        let settings_path = new_backup.to_string_lossy().into_owned();
        let settings_thread = thread::spawn(move || {
            let mut settings = settings_backend.get_settings().unwrap();
            settings.backup_path = settings_path;
            settings_barrier.wait();
            settings_backend.set_settings(settings).unwrap();
        });
        let mutation_backend = Arc::clone(&backend);
        let mutation_barrier = Arc::clone(&barrier);
        let second_project = root.path().join("second-project");
        fs::create_dir(&second_project).unwrap();
        let mutation_thread = thread::spawn(move || {
            mutation_barrier.wait();
            mutation_backend
                .create_folder(second_project.to_string_lossy().into_owned(), None)
                .unwrap();
        });
        barrier.wait();
        settings_thread.join().unwrap();
        mutation_thread.join().unwrap();

        let active_settings = backend.get_settings().unwrap();
        assert_eq!(active_settings.backup_path, new_backup.to_string_lossy());
        let active_registry = Registry::load_from_backup_path(&new_backup).unwrap();
        assert_eq!(active_registry.folders.len(), 2);
        assert_eq!(
            ScrollbackStore::new(&new_backup)
                .read_bytes(&session.id)
                .unwrap(),
            b"synthetic transcript\n\xff"
        );
    }

    #[test]
    fn failed_backup_transition_keeps_old_settings_registry_and_scrollback() {
        let (root, backend, _) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        backend.stop_session(&session.id).unwrap();
        backend
            .scrollback_store()
            .unwrap()
            .replace(&session.id, b"keep me")
            .unwrap();
        let old_settings = backend.get_settings().unwrap();
        let blocked = root.path().join("blocked-backup");
        fs::write(&blocked, b"not a directory").unwrap();
        let mut proposed = old_settings.clone();
        proposed.backup_path = blocked.to_string_lossy().into_owned();

        assert!(backend.set_settings(proposed).is_err());
        assert_eq!(backend.get_settings().unwrap(), old_settings);
        assert_eq!(backend.get_state().unwrap().sessions.len(), 1);
        assert_eq!(backend.get_scrollback(&session.id).unwrap(), "keep me");
    }

    #[test]
    fn failed_registry_removal_preserves_session_and_scrollback() {
        let root = tempdir().unwrap();
        let blocked = root.path().join("registry-parent-file");
        fs::write(&blocked, b"not a directory").unwrap();
        let scrollback_root = root.path().join("scrollback-backup");
        let mut settings = Settings::default();
        settings.backup_path = scrollback_root.to_string_lossy().into_owned();
        let folder_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let session_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let mut registry = Registry::empty(blocked.join("nested"));
        registry.folders.push(Folder {
            id: folder_id.clone(),
            name: "synthetic".into(),
            path: root.path().to_string_lossy().into_owned(),
        });
        registry.sessions.push(Session {
            id: session_id.clone(),
            folder_id,
            tool: Tool::Terminal,
            title: "synthetic".into(),
            cli_session_id: None,
            status: Status::Stopped,
            model: None,
            extra_args: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
            last_active_at: Utc::now().to_rfc3339(),
            was_open_in_tab: false,
        });
        let backend = Backend::for_test(
            SettingsStore::new(root.path().join("settings.json")),
            settings,
            registry,
            Arc::new(FakeRuntime::default()),
            Arc::new(TestEvents::default()),
        );
        backend
            .scrollback_store()
            .unwrap()
            .replace(&session_id, b"irreplaceable transcript")
            .unwrap();

        assert!(backend.delete_session(&session_id).is_err());
        assert!(backend.session(&session_id).is_ok());
        assert_eq!(
            backend.get_scrollback(&session_id).unwrap(),
            "irreplaceable transcript"
        );
    }

    #[test]
    fn tab_close_stop_failure_does_not_persist_closed_state() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        runtime.fail_stop.store(true, Ordering::Release);

        assert!(backend.set_tab_open(&session.id, false).is_err());
        assert!(backend.session(&session.id).unwrap().was_open_in_tab);
    }

    #[cfg(unix)]
    #[test]
    fn hanging_version_process_is_killed_and_output_is_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let executable = root.path().join("hanging-cli");
        fs::write(
            &executable,
            b"#!/bin/sh\nwhile true; do printf '0123456789'; done\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let started = std::time::Instant::now();

        assert_eq!(bounded_version(&executable), None);
        assert!(started.elapsed() < Duration::from_secs(3));
        let (_, backend, _) = harness();
        assert_eq!(backend.detect_clis().unwrap().len(), 5);
    }

    #[test]
    fn lifecycle_operations_prevent_orphaned_launch_resume_and_removal_races() {
        let (root, backend, runtime) = harness();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let folder = backend
            .create_folder(project.to_string_lossy().into(), None)
            .unwrap();
        let session = backend
            .launch_session(&folder.id, Tool::Terminal, None, None)
            .unwrap();
        backend.stop_session(&session.id).unwrap();

        let barrier = Arc::new(std::sync::Barrier::new(3));
        let resume_backend = Arc::clone(&backend);
        let resume_barrier = Arc::clone(&barrier);
        let session_id = session.id.clone();
        let resume = thread::spawn(move || {
            resume_barrier.wait();
            resume_backend.resume_session(&session_id)
        });
        let delete_backend = Arc::clone(&backend);
        let delete_barrier = Arc::clone(&barrier);
        let delete_id = session.id.clone();
        let delete = thread::spawn(move || {
            delete_barrier.wait();
            delete_backend.delete_session(&delete_id)
        });
        barrier.wait();
        let _ = resume.join().unwrap();
        delete.join().unwrap().unwrap();
        assert!(!runtime.is_live(&session.id));
        assert!(backend.session(&session.id).is_err());

        let second_folder = backend
            .create_folder(project.to_string_lossy().into(), Some("second".into()))
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let launch_backend = Arc::clone(&backend);
        let launch_barrier = Arc::clone(&barrier);
        let launch_folder = second_folder.id.clone();
        let launch = thread::spawn(move || {
            launch_barrier.wait();
            launch_backend.launch_session(&launch_folder, Tool::Terminal, None, None)
        });
        let remove_backend = Arc::clone(&backend);
        let remove_barrier = Arc::clone(&barrier);
        let remove_folder = second_folder.id.clone();
        let remove = thread::spawn(move || {
            remove_barrier.wait();
            remove_backend.remove_folder(&remove_folder)
        });
        barrier.wait();
        let launched = launch.join().unwrap().ok();
        remove.join().unwrap().unwrap();
        if let Some(launched) = launched {
            assert!(!runtime.is_live(&launched.id));
        }
        assert!(backend
            .get_state()
            .unwrap()
            .sessions
            .iter()
            .all(|session| session.folder_id != second_folder.id));
    }

    #[cfg(unix)]
    #[test]
    fn successful_version_parent_with_pipe_holding_descendant_is_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let executable = root.path().join("forking-cli");
        fs::write(
            &executable,
            b"#!/bin/sh\nsleep 5 &\nprintf 'synthetic-cli 1.0\\n'\nexit 0\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let started = std::time::Instant::now();

        assert_eq!(
            bounded_version(&executable).as_deref(),
            Some("synthetic-cli 1.0")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn version_probe_policy_never_spawns_uncontained_windows_processes() {
        assert!(!supports_contained_version_probe(true));
        assert!(supports_contained_version_probe(false));
    }

    #[cfg(windows)]
    #[test]
    fn windows_version_detection_does_not_execute_the_binary() {
        let root = tempdir().unwrap();
        let marker = root.path().join("must-not-exist.txt");
        let executable = root.path().join("synthetic-cli.cmd");
        fs::write(
            &executable,
            format!("@echo off\r\necho executed>\"{}\"\r\n", marker.display()),
        )
        .unwrap();

        assert_eq!(bounded_version(&executable), None);
        assert!(!marker.exists());
    }
}

#[cfg(test)]
#[path = "backend_manual_smoke.rs"]
mod manual_smoke;
