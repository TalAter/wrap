//! Shared fixtures for the session integration tests.
#![allow(dead_code)]

use std::collections::HashMap;

use serde_json::{Value, json};
use wrap::cli::Modifiers;
use wrap::config::{Config, ResolvedConfig, ResolvedProvider, resolve_settings};
use wrap::llm::{Llm, LlmConfig, TestResponses};
use wrap::response::CommandResponse;

pub fn response(v: Value) -> CommandResponse {
    serde_json::from_value(v).unwrap()
}

/// A final command at `risk`.
pub fn cmd(content: &str, risk: &str) -> CommandResponse {
    response(json!({"type":"command","final":true,"content":content,"risk_level":risk}))
}

/// A non-final command at `risk`.
pub fn step(content: &str, risk: &str) -> CommandResponse {
    response(json!({"type":"command","final":false,"content":content,"risk_level":risk}))
}

pub fn reply(content: &str) -> CommandResponse {
    response(json!({"type":"reply","final":true,"content":content,"risk_level":"low"}))
}

/// A test-provider handle over canned responses (one entry per physical call).
pub fn llm_list(items: Vec<Value>) -> Llm {
    Llm::new(LlmConfig::Test(TestResponses::List(items)), &HashMap::new()).unwrap()
}

/// A test-provider handle that plays `raw` on every call.
pub fn llm_single(raw: &str) -> Llm {
    Llm::new(
        LlmConfig::Test(TestResponses::Single(Value::String(raw.into()))),
        &HashMap::new(),
    )
    .unwrap()
}

pub fn test_provider() -> ResolvedProvider {
    ResolvedProvider {
        name: "test".into(),
        model: None,
        api_key: None,
        base_url: None,
    }
}

/// Settings resolved from defaults, patched by `f`.
pub fn config(f: impl FnOnce(&mut Config)) -> ResolvedConfig {
    let mut file = Config::default();
    f(&mut file);
    resolve_settings(&Modifiers::default(), &HashMap::new(), &file).unwrap()
}

pub fn default_config() -> ResolvedConfig {
    config(|_| {})
}

use std::sync::{Mutex, MutexGuard};

use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use wrap::chrome::{Notification, SubscriptionGuard};

/// The chrome bus has one subscriber per process; tests that capture or emit
/// through it hold this lock so they never see each other's lines.
pub static BUS: Mutex<()> = Mutex::new(());

pub fn bus_lock() -> MutexGuard<'static, ()> {
    BUS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Everything emitted on the chrome bus while this capture is alive.
pub struct BusCapture {
    rx: UnboundedReceiver<Notification>,
    _guard: SubscriptionGuard,
}

impl BusCapture {
    pub fn start() -> BusCapture {
        let (tx, rx) = unbounded_channel();
        let guard = wrap::chrome::subscribe(tx);
        BusCapture { rx, _guard: guard }
    }

    pub fn drain(&mut self) -> Vec<Notification> {
        let mut out = Vec::new();
        while let Ok(n) = self.rx.try_recv() {
            out.push(n);
        }
        out
    }

    /// The captured notifications rendered the way stderr would show them.
    pub fn text(&mut self) -> String {
        self.drain()
            .iter()
            .map(|n| match n {
                Notification::Chrome { text, icon } => match icon {
                    Some(icon) => format!("{icon} {text}\n"),
                    None => format!("{text}\n"),
                },
                Notification::Verbose { line } => line.clone(),
                Notification::StepOutput { .. } => String::new(),
            })
            .collect()
    }
}

use std::collections::VecDeque;
use std::path::PathBuf;

use tempfile::TempDir;
use wrap::home::WrapHome;
use wrap::logging::{LogEntry, read_log_entries};
use wrap::session::state::{AppEvent, AppState};
use wrap::session::{DialogHost, HostFuture, SessionOptions};

type Predicate = Box<dyn Fn(&AppState) -> bool>;

/// A scripted terminal: records mounts and stderr lines, and answers the
/// coordinator's event poll with the next scripted event whose predicate
/// matches the mounted state.
pub struct FakeHost {
    pub stderr_tty: bool,
    pub stdin_tty: bool,
    script: VecDeque<(Predicate, AppEvent)>,
    pub mounted: Option<AppState>,
    /// Every state the dialog was asked to show, in order.
    pub shown: Vec<AppState>,
    /// `mount:<tag>` / `unmount` / `editor` / `stderr:<text>` in order.
    pub log: Vec<String>,
    pub stderr: Vec<wrap::chrome::Notification>,
    /// Step output handed to the host as its own notification kind; the
    /// real host never prints these.
    pub step_outputs: Vec<String>,
    pub editor_result: Option<String>,
    pub editor_drafts: Vec<String>,
    pub continuation_prompt: Option<String>,
}

impl FakeHost {
    pub fn tty() -> FakeHost {
        FakeHost {
            stderr_tty: true,
            stdin_tty: true,
            script: VecDeque::new(),
            mounted: None,
            shown: Vec::new(),
            log: Vec::new(),
            stderr: Vec::new(),
            step_outputs: Vec::new(),
            editor_result: None,
            editor_drafts: Vec::new(),
            continuation_prompt: None,
        }
    }

    pub fn no_tty() -> FakeHost {
        FakeHost {
            stderr_tty: false,
            stdin_tty: false,
            ..FakeHost::tty()
        }
    }

    /// Fire `event` the first time the dialog shows a state matching `when`.
    pub fn on(mut self, when: impl Fn(&AppState) -> bool + 'static, event: AppEvent) -> FakeHost {
        self.script.push_back((Box::new(when), event));
        self
    }

    /// Everything that would reach stderr, rendered as the real host would.
    /// A step output here would be a leak, so it renders as its text.
    pub fn stderr_text(&self) -> String {
        self.stderr
            .iter()
            .map(|n| match n {
                wrap::chrome::Notification::Chrome { text, icon } => match icon {
                    Some(icon) => format!("{icon} {text}\n"),
                    None => format!("{text}\n"),
                },
                wrap::chrome::Notification::Verbose { line } => line.clone(),
                wrap::chrome::Notification::StepOutput { text } => text.clone(),
            })
            .collect()
    }

    pub fn remaining_script(&self) -> usize {
        self.script.len()
    }
}

impl DialogHost for FakeHost {
    fn stderr_is_tty(&self) -> bool {
        self.stderr_tty
    }

    fn stdin_is_tty(&self) -> bool {
        self.stdin_tty
    }

    fn mount(&mut self, state: &AppState, continuation_prompt: Option<&str>) -> Result<(), String> {
        self.log.push(format!("mount:{:?}", state.tag()));
        self.continuation_prompt = continuation_prompt.map(str::to_string);
        self.mounted = Some(state.clone());
        self.shown.push(state.clone());
        Ok(())
    }

    fn rerender(&mut self, state: &AppState) {
        self.mounted = Some(state.clone());
        self.shown.push(state.clone());
    }

    fn unmount(&mut self) {
        self.log.push("unmount".into());
        self.mounted = None;
    }

    fn next_event(&mut self) -> HostFuture<'_, Result<AppEvent, String>> {
        Box::pin(async move {
            if let Some(state) = &self.mounted
                && self.script.front().is_some_and(|(when, _)| when(state))
            {
                let (_, event) = self.script.pop_front().unwrap();
                return Ok(event);
            }
            std::future::pending().await
        })
    }

    fn edit_in_editor(&mut self, draft: String) -> HostFuture<'_, Option<String>> {
        Box::pin(async move {
            self.log.push("editor".into());
            self.editor_drafts.push(draft);
            self.editor_result.clone()
        })
    }

    fn write_notification(&mut self, notification: &wrap::chrome::Notification) {
        match notification {
            wrap::chrome::Notification::StepOutput { text } => {
                self.step_outputs.push(text.clone());
            }
            wrap::chrome::Notification::Chrome { text, .. } => {
                self.log.push(format!("stderr:{text}"));
                self.stderr.push(notification.clone());
            }
            wrap::chrome::Notification::Verbose { .. } => self.stderr.push(notification.clone()),
        }
    }
}

/// A session's isolated `$WRAP_HOME` plus default options pointing at it.
pub struct SessionRig {
    pub dir: TempDir,
    pub home: WrapHome,
}

impl SessionRig {
    pub fn new() -> SessionRig {
        let dir = tempfile::tempdir().unwrap();
        let home = WrapHome::new(dir.path());
        SessionRig { dir, home }
    }

    pub fn options(&self, f: impl FnOnce(&mut SessionOptions)) -> SessionOptions {
        let mut options = SessionOptions {
            home: self.home.clone(),
            config: default_config(),
            memory: None,
            cwd: PathBuf::from("/tmp"),
            resolved_provider: test_provider(),
            skills: None,
            attached_input_path: None,
            attached_input_size: None,
            attached_input_preview: None,
            attached_input_truncated: false,
            input_source: Some("argv".into()),
            continuation_parent: None,
        };
        f(&mut options);
        options
    }

    pub fn last_entry(&self) -> LogEntry {
        read_log_entries(&self.home)
            .pop()
            .expect("a log entry was written")
    }
}

pub fn turn_kinds(entry: &LogEntry) -> Vec<&'static str> {
    entry
        .turns
        .iter()
        .map(|t| match t {
            wrap::logging::Turn::User { .. } => "user",
            wrap::logging::Turn::Assistant { .. } => "assistant",
            wrap::logging::Turn::Step { .. } => "step",
            wrap::logging::Turn::Probe { .. } => "probe",
            wrap::logging::Turn::Final { .. } => "final",
        })
        .collect()
}

pub fn final_turn(entry: &LogEntry) -> Option<(&str, Option<i32>, &str)> {
    entry.turns.iter().find_map(|t| match t {
        wrap::logging::Turn::Final {
            command,
            exit_code,
            source,
            ..
        } => Some((command.as_str(), *exit_code, source.as_str())),
        _ => None,
    })
}
