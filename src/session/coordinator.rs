//! The coordinator: owns the transcript, the loop state, the in-flight loop
//! task, the dialog mount and the notification routing. It feeds loop
//! results, bus notifications and dialog input through the reducer and acts
//! on the states it lands in: start a new loop after a follow-up, capture a
//! confirmed step, hand the terminal to an external editor, or finalise.

use std::future::Future;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use tokio_util::sync::CancellationToken;

use super::reducer::reduce;
use super::router::{NotificationRouter, Routed};
use super::runner::{LoopEvent, LoopOptions, LoopState, Transcript, merge_step_output, run_loop};
use super::state::{AppEvent, AppState, LoopReturn, SessionOutcome, StateTag, StepSource};
use crate::chrome::{self, Notification, SubscriptionGuard, verbose};
use crate::config::{ResolvedConfig, ResolvedProvider};
use crate::editor::{resolve_editor_from_env, spawn_editor};
use crate::home::WrapHome;
use crate::llm::{ConversationOptions, Llm};
use crate::logging::{
    AttachedInputParams, LogEntry, LogEntryParams, Turn, append_log_entry, create_log_entry,
};
use crate::memory::Memory;
use crate::prompt::{
    QueryContext, RequestFraming, TurnFramer, assemble_prompt_scaffold, format_command_echo,
    optimized,
};
use crate::response::{CommandResponse, ResponseType, RiskLevel};
use crate::shell::{ShellMode, execute_shell_command};
use crate::skills::{Skill, SkillContext, run_skills};

/// The `-c` chain this invocation resumes. `assembled_turns` is every
/// ancestor's turns in order; `parent_prompt` is the chain root's prompt,
/// shown as the dialog's continuation badge.
#[derive(Clone, Debug, PartialEq)]
pub struct ContinuationParent {
    pub parent_id: String,
    pub assembled_turns: Vec<Turn>,
    pub parent_prompt: String,
}

pub struct SessionOptions {
    pub home: WrapHome,
    pub config: ResolvedConfig,
    pub memory: Option<Memory>,
    pub cwd: PathBuf,
    pub resolved_provider: ResolvedProvider,
    /// Run before the first LLM call on each user-prompt entry point (argv
    /// at start, the draft on interactive submit); their probe turns land
    /// ahead of the user turn so the request stays the freshest message.
    pub skills: Option<Vec<Skill>>,
    pub attached_input_path: Option<String>,
    pub attached_input_size: Option<u64>,
    pub attached_input_preview: Option<String>,
    pub attached_input_truncated: bool,
    /// `argv` | `pipe` | `tui`. The interactive composer stamps `tui` itself.
    pub input_source: Option<String>,
    pub continuation_parent: Option<ContinuationParent>,
}

pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// The seam to the terminal. The coordinator mounts, re-renders and unmounts
/// the response dialog through it, pulls user events from it, and writes
/// stderr chrome through it; a scripted implementation drives tests.
pub trait DialogHost {
    /// Whether stderr is a terminal the dialog can take over.
    fn stderr_is_tty(&self) -> bool;
    /// Whether stdin is a terminal; an empty prompt on one opens the
    /// interactive composer.
    fn stdin_is_tty(&self) -> bool;
    /// Show the dialog for `state`. `continuation_prompt` is the `-c` badge.
    fn mount(&mut self, state: &AppState, continuation_prompt: Option<&str>) -> Result<(), String>;
    fn rerender(&mut self, state: &AppState);
    /// Leave the alternate screen and restore the terminal.
    fn unmount(&mut self);
    /// The next user event from the mounted dialog. Only polled while
    /// mounted; dropped and recreated after every state change, so it must
    /// keep no progress of its own. `Err` ends the session with the message.
    fn next_event(&mut self) -> HostFuture<'_, Result<AppEvent, String>>;
    /// Run a terminal-owning editor on `draft` with the dialog unmounted.
    /// `None` keeps the draft the user had.
    fn edit_in_editor(&mut self, draft: String) -> HostFuture<'_, Option<String>>;
    /// Write a notification that is not going to a dialog.
    fn write_notification(&mut self, notification: &Notification) {
        chrome::write_notification_to_stderr(notification);
    }
}

/// `$VISUAL` / `$EDITOR` / the first known editor on PATH, run on `draft`.
/// A non-zero exit or launch failure shows its notice as chrome and keeps
/// the draft. The hook real hosts use for [`DialogHost::edit_in_editor`].
pub async fn run_terminal_editor(draft: &str, home: &WrapHome) -> Option<String> {
    let resolved = resolve_editor_from_env()?;
    match spawn_editor(&resolved, draft, home, None).await {
        Ok(text) => text,
        Err(notice) => {
            chrome::chrome(&notice, None);
            None
        }
    }
}

/// What the coordinator does when a loop finishes without a dialog to
/// confirm on.
fn needs_tty_block(result: &LoopReturn, is_initial: bool, has_tty: bool, yolo: bool) -> bool {
    matches!(
        result,
        LoopReturn::Command(response) if response.risk_level != RiskLevel::Low
    ) && is_initial
        && !has_tty
        && !yolo
}

fn is_live_tag(tag: StateTag) -> bool {
    matches!(
        tag,
        StateTag::ProcessingFollowup | StateTag::ProcessingInteractive | StateTag::ExecutingStep
    )
}

/// Per-session values the loop task needs.
struct Shared {
    home: WrapHome,
    config: ResolvedConfig,
    cwd: PathBuf,
    label: String,
    skills: Option<Vec<Skill>>,
}

impl Shared {
    fn skill_context(&self) -> SkillContext {
        SkillContext {
            home: self.home.clone(),
            cwd: self.cwd.clone(),
            max_captured_output_chars: self.config.max_captured_output_chars,
        }
    }
}

/// Skill turns sit between the scaffold and the user prompt so the user's
/// request is the last and freshest message.
async fn seed_first_user_turn(shared: &Shared, prompt: &str, transcript: &mut Transcript) {
    if let Some(skills) = &shared.skills {
        let turns = run_skills(skills, prompt, &shared.skill_context()).await;
        verbose(
            shared.config.verbose,
            &format!("Skill turns: {}", turns.len()),
        );
        for turn in turns {
            transcript.append_turn(turn.into());
        }
    }
    transcript.append_turn(Turn::User {
        text: prompt.to_string(),
    });
}

/// The transcript and budget, owned by whichever side is working: the
/// coordinator between loops, the loop task while one runs.
struct LoopCore {
    transcript: Transcript,
    loop_state: LoopState,
}

/// Work a loop task does before its first round.
enum Prelude {
    None,
    /// Append the follow-up as a user turn.
    Followup(String),
    /// Capture a confirmed non-final step and append its step turn.
    Step {
        response: CommandResponse,
        source: StepSource,
    },
    /// Run skills and seed the interactive prompt as the first user turn.
    Seed(String),
}

async fn run_task(
    prelude: Prelude,
    core: &mut LoopCore,
    options: &LoopOptions,
    shared: &Shared,
) -> Result<LoopReturn, String> {
    match prelude {
        Prelude::None | Prelude::Followup(_) => {}
        Prelude::Step { response, source } => {
            let exec = match execute_shell_command(
                &response.content,
                ShellMode::Capture,
                Some(options.cancel.clone()),
            )
            .await
            {
                Ok(exec) => exec,
                Err(_) if options.cancel.is_cancelled() => return Ok(LoopReturn::Aborted),
                Err(e) => return Err(format!("Could not run the step: {e}")),
            };
            if options.cancel.is_cancelled() {
                return Ok(LoopReturn::Aborted);
            }
            let output = merge_step_output(
                &exec.stdout,
                &exec.stderr,
                shared.config.max_captured_output_chars,
            );
            let _ = options.events.send(LoopEvent::StepOutput {
                text: output.clone(),
            });
            core.transcript.append_turn(Turn::Step {
                command: response.content,
                exit_code: exec.exit_code,
                output,
                shell: exec.shell,
                source: source.as_str().to_string(),
                exec_ms: Some(exec.exec_ms),
            });
        }
        Prelude::Seed(prompt) => {
            seed_first_user_turn(shared, &prompt, &mut core.transcript).await;
            if options.cancel.is_cancelled() {
                return Ok(LoopReturn::Aborted);
            }
        }
    }
    run_loop(&mut core.transcript, &mut core.loop_state, options).await
}

type TaskResult = (LoopCore, Result<LoopReturn, String>);
type LoopTask = Pin<Box<dyn Future<Output = TaskResult>>>;

/// A loop in flight. The task owns the core until it settles; cancelling the
/// token makes it settle promptly, and the coordinator keeps polling it to
/// take the core back, ignoring whatever it returns.
struct ActiveLoop {
    task: LoopTask,
    events: UnboundedReceiver<LoopEvent>,
    cancel: CancellationToken,
    /// Started from `thinking`: the only loop with no dialog to confirm on.
    is_initial: bool,
}

/// Side effects a transition asks for, run after the reducer settles.
enum Hook {
    StartLoop(Prelude),
    Editor(String),
}

enum Wake {
    LoopEvent(LoopEvent),
    LoopDone(TaskResult),
    Notification(Option<Notification>),
    Host(Result<AppEvent, String>),
}

async fn recv_events(events: Option<&mut UnboundedReceiver<LoopEvent>>) -> Option<LoopEvent> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
    }
}

async fn join_loop(task: Option<&mut LoopTask>) -> TaskResult {
    match task {
        Some(task) => task.await,
        None => std::future::pending().await,
    }
}

async fn recv_notification(
    notifications: Option<&mut UnboundedReceiver<Notification>>,
) -> Option<Notification> {
    match notifications {
        Some(notifications) => notifications.recv().await,
        None => std::future::pending().await,
    }
}

async fn host_event(host: &mut dyn DialogHost, mounted: bool) -> Result<AppEvent, String> {
    if mounted {
        host.next_event().await
    } else {
        std::future::pending().await
    }
}

struct Session {
    shared: Arc<Shared>,
    state: AppState,
    core: Option<LoopCore>,
    active: Option<ActiveLoop>,
    router: NotificationRouter,
    /// `None` once the bus has moved on to another subscriber.
    notifications: Option<UnboundedReceiver<Notification>>,
    hooks: Vec<Hook>,
    outcome: Option<SessionOutcome>,
    continuation_prompt: Option<String>,
    input_source: Option<String>,
}

impl Session {
    fn yolo(&self) -> bool {
        self.shared.config.yolo
    }

    fn fail(&mut self, message: String) {
        self.state = AppState::Exiting {
            outcome: SessionOutcome::Error(message.clone()),
        };
        self.outcome = Some(SessionOutcome::Error(message));
    }

    fn dispatch(&mut self, event: AppEvent, host: &mut dyn DialogHost) {
        if self.outcome.is_some() {
            return;
        }
        // Esc while a loop or capture is in flight cancels it before the
        // reducer moves on, so a result about to land is dropped.
        if matches!(event, AppEvent::KeyEsc)
            && is_live_tag(self.state.tag())
            && let Some(active) = &self.active
        {
            active.cancel.cancel();
        }
        let prev = self.state.tag();
        let Some(next) = reduce(&self.state, &event, self.yolo()) else {
            return;
        };
        self.state = next;
        self.sync_dialog(host);
        if let AppState::Exiting { outcome } = &self.state {
            self.outcome = Some(outcome.clone());
            return;
        }
        if self.state.tag() == prev {
            return;
        }
        match &self.state {
            AppState::ProcessingFollowup { draft, .. } => {
                self.hooks
                    .push(Hook::StartLoop(Prelude::Followup(draft.clone())));
            }
            AppState::ProcessingInteractive { draft, .. } => {
                self.input_source = Some("tui".to_string());
                // While the dialog is up these lines buffer and flush on
                // teardown, so the submitted prompt lands in scrollback.
                if self.shared.config.verbose {
                    for line in draft.split('\n') {
                        verbose(true, &format!("prompt: {line}"));
                    }
                }
                self.hooks
                    .push(Hook::StartLoop(Prelude::Seed(draft.clone())));
            }
            AppState::EditorHandoff { draft, .. } => self.hooks.push(Hook::Editor(draft.clone())),
            AppState::ExecutingStep {
                response, source, ..
            } => self.hooks.push(Hook::StartLoop(Prelude::Step {
                response: response.clone(),
                source: *source,
            })),
            _ => {}
        }
    }

    fn sync_dialog(&mut self, host: &mut dyn DialogHost) {
        let wants = self.state.is_dialog();
        let mounted = self.router.is_dialog_mounted();
        if wants && !mounted {
            match host.mount(&self.state, self.continuation_prompt.as_deref()) {
                Ok(()) => self.router.set_dialog_mounted(),
                Err(message) => self.fail(message),
            }
        } else if wants && mounted {
            host.rerender(&self.state);
        } else if !wants && mounted {
            self.teardown_dialog(host);
        }
    }

    /// Unmount first, then flush: the lines must land in scrollback, not in
    /// the alternate buffer that is about to disappear.
    fn teardown_dialog(&mut self, host: &mut dyn DialogHost) {
        if let Some(flushed) = self.router.teardown_dialog() {
            host.unmount();
            for notification in &flushed {
                host.write_notification(notification);
            }
        }
    }

    fn handle_notification(&mut self, notification: Notification, host: &mut dyn DialogHost) {
        let live = is_live_tag(self.state.tag());
        match self.router.route(notification, live) {
            Routed::Stderr(n) => host.write_notification(&n),
            Routed::Buffered => {}
            Routed::Live(n) => self.dispatch(AppEvent::Notification(n), host),
        }
    }

    fn drain_notifications(&mut self, host: &mut dyn DialogHost) {
        while let Some(notification) = self.notifications.as_mut().and_then(|n| n.try_recv().ok()) {
            self.handle_notification(notification, host);
        }
    }

    fn handle_loop_event(&mut self, event: LoopEvent) {
        match event {
            LoopEvent::AssistantTurn { .. } => {}
            LoopEvent::StepOutput { text } => chrome::emit(Notification::StepOutput { text }),
        }
    }

    fn handle_loop_done(&mut self, (core, result): TaskResult, host: &mut dyn DialogHost) {
        let Some(mut active) = self.active.take() else {
            return;
        };
        while let Ok(event) = active.events.try_recv() {
            self.handle_loop_event(event);
        }
        self.drain_notifications(host);
        self.core = Some(core);
        // A cancelled loop's result is stale: the user already moved on.
        if active.cancel.is_cancelled() {
            return;
        }
        match result {
            Ok(result) => {
                if needs_tty_block(
                    &result,
                    active.is_initial,
                    host.stderr_is_tty(),
                    self.yolo(),
                ) && let LoopReturn::Command(response) = result
                {
                    chrome::chrome(
                        &format!(
                            "Command requires confirmation (no TTY available): {}",
                            response.content
                        ),
                        None,
                    );
                    self.drain_notifications(host);
                    self.dispatch(
                        AppEvent::Block {
                            command: response.content.clone(),
                            response,
                        },
                        host,
                    );
                    return;
                }
                self.dispatch(AppEvent::LoopFinal { result }, host);
            }
            Err(message) => self.dispatch(AppEvent::LoopError { message }, host),
        }
    }

    /// Take the core back, waiting for a cancelled loop to notice and stop.
    async fn reclaim(&mut self) -> LoopCore {
        if let Some(core) = self.core.take() {
            return core;
        }
        let active = self.active.take().expect("either side owns the core");
        active.task.await.0
    }

    async fn start_loop(&mut self, prelude: Prelude) {
        let mut core = self.reclaim().await;
        if let Prelude::Followup(text) = &prelude {
            // The previous assistant turn is already on the transcript, so
            // the model sees `[..., assistant, user]`.
            core.transcript
                .append_turn(Turn::User { text: text.clone() });
        }
        core.loop_state.budget_remaining = self.shared.config.max_rounds;
        let cancel = CancellationToken::new();
        let (tx, events) = unbounded_channel();
        let shared = self.shared.clone();
        let options = LoopOptions {
            cwd: shared.cwd.clone(),
            label: shared.label.clone(),
            home: shared.home.clone(),
            config: shared.config.clone(),
            // The dialog's bottom-border spinner and the stderr spinner
            // report the same thing; only one runs at a time.
            show_spinner: !self.state.is_dialog(),
            cancel: cancel.clone(),
            events: tx,
        };
        let is_initial = self.state.tag() == StateTag::Thinking;
        let task: LoopTask = Box::pin(async move {
            let result = run_task(prelude, &mut core, &options, &shared).await;
            (core, result)
        });
        self.active = Some(ActiveLoop {
            task,
            events,
            cancel,
            is_initial,
        });
    }

    async fn run_hooks(&mut self, host: &mut dyn DialogHost) {
        for hook in std::mem::take(&mut self.hooks) {
            match hook {
                Hook::StartLoop(prelude) => self.start_loop(prelude).await,
                Hook::Editor(draft) => {
                    let text = host.edit_in_editor(draft).await;
                    self.dispatch(AppEvent::EditorDone { text }, host);
                }
            }
        }
    }

    async fn drive(&mut self, host: &mut dyn DialogHost) -> SessionOutcome {
        loop {
            if let Some(outcome) = self.outcome.take() {
                return outcome;
            }
            if !self.hooks.is_empty() {
                self.run_hooks(host).await;
                continue;
            }
            let mounted = self.router.is_dialog_mounted();
            let wake = {
                let (events, task) = match &mut self.active {
                    Some(active) => (Some(&mut active.events), Some(&mut active.task)),
                    None => (None, None),
                };
                tokio::select! {
                    biased;
                    Some(event) = recv_events(events) => Wake::LoopEvent(event),
                    done = join_loop(task) => Wake::LoopDone(done),
                    notification = recv_notification(self.notifications.as_mut()) => {
                        Wake::Notification(notification)
                    }
                    event = host_event(host, mounted) => Wake::Host(event),
                }
            };
            match wake {
                Wake::LoopEvent(event) => self.handle_loop_event(event),
                Wake::LoopDone(joined) => self.handle_loop_done(joined, host),
                Wake::Notification(Some(n)) => self.handle_notification(n, host),
                // Another subscriber took the bus; its lines are theirs now.
                Wake::Notification(None) => self.notifications = None,
                Wake::Host(Ok(event)) => self.dispatch(event, host),
                Wake::Host(Err(message)) => self.fail(message),
            }
        }
    }
}

/// Run one user query end to end and return the process exit code. An
/// `Err` is the session's own failure, already recorded in the log; the
/// caller prints it.
pub async fn run_session(
    prompt: String,
    llm: &Llm,
    options: SessionOptions,
    host: &mut dyn DialogHost,
) -> Result<i32, String> {
    let (bus_tx, notifications) = unbounded_channel();
    let subscription: SubscriptionGuard = chrome::subscribe(bus_tx);
    let config = options.config.clone();
    let home = options.home.clone();
    let memory = options.memory.unwrap_or_default();

    let mut entry = create_log_entry(LogEntryParams {
        cwd: options.cwd.to_string_lossy().into_owned(),
        attached_input: match (&options.attached_input_path, options.attached_input_size) {
            (Some(path), Some(size)) => Some(AttachedInputParams {
                path: path.clone(),
                size,
                preview: options.attached_input_preview.clone().unwrap_or_default(),
            }),
            _ => None,
        },
        memory: Some(memory.clone()),
        provider: options.resolved_provider.clone(),
        prompt_hash: optimized().prompt_hash.clone(),
        input_source: options.input_source.clone(),
        ppid: None,
    });

    let scaffold = assemble_prompt_scaffold(&QueryContext {
        cwd: options.cwd.to_string_lossy().into_owned(),
        memory,
        piped: !io::stdout().is_terminal(),
        attached_input_path: options.attached_input_path.clone(),
        attached_input_size: options.attached_input_size,
        attached_input_preview: options.attached_input_preview.clone(),
        attached_input_truncated: options.attached_input_truncated,
    });

    // One conversation per invocation: the scaffold's few-shot prefix enters
    // as real adds, every later turn is framed as it is appended, and
    // assistant echoes enter through the send via the echo predicate.
    let mut chat = llm.start_conversation(ConversationOptions {
        system: scaffold.system,
        format_echo: Some(format_command_echo()),
    });
    for message in scaffold.prefix_messages {
        chat.add(message, false);
    }
    let framer = TurnFramer::new(Some(RequestFraming {
        context_string: scaffold.context_string,
        section_user_request: scaffold.section_user_request,
    }));
    let mut transcript = Transcript::new(chat, framer);

    let continuation_len = options
        .continuation_parent
        .as_ref()
        .map(|p| p.assembled_turns.len())
        .unwrap_or(0);
    let mut continuation_prompt = None;
    if let Some(parent) = options.continuation_parent {
        entry.parent_id = Some(parent.parent_id);
        continuation_prompt = Some(parent.parent_prompt);
        // The ancestor chain re-enters with this invocation's framing; its
        // `final` turns become notes, the only time they are projected.
        for turn in parent.assembled_turns {
            transcript.append_turn(turn);
        }
    }

    let shared = Arc::new(Shared {
        home: home.clone(),
        config: config.clone(),
        cwd: options.cwd.clone(),
        label: llm.label().to_string(),
        skills: options.skills,
    });

    // No prompt on a terminal: the composer is the entry point, and the
    // transcript stays empty until submit.
    let interactive = prompt.is_empty() && host.stdin_is_tty();
    if !interactive {
        seed_first_user_turn(&shared, &prompt, &mut transcript).await;
    }

    let mut session = Session {
        shared,
        state: if interactive {
            AppState::ComposingInteractive {
                draft: String::new(),
            }
        } else {
            AppState::Thinking
        },
        core: Some(LoopCore {
            transcript,
            loop_state: LoopState {
                budget_remaining: config.max_rounds,
                round_num: 0,
            },
        }),
        active: None,
        router: NotificationRouter::new(),
        notifications: Some(notifications),
        hooks: Vec::new(),
        outcome: None,
        continuation_prompt,
        input_source: entry.input_source.clone(),
    };
    if interactive {
        session.sync_dialog(host);
    } else {
        session.hooks.push(Hook::StartLoop(Prelude::None));
    }

    let outcome = session.drive(host).await;
    // Unmount before exec so the alternate screen is gone when the command
    // writes to the inherited terminal.
    session.teardown_dialog(host);
    if let Some(active) = &session.active {
        active.cancel.cancel();
    }
    entry.turns = session.reclaim().await.transcript.turns;
    entry.input_source = session.input_source.clone();
    session.drain_notifications(host);
    // From here chrome goes straight to stderr again.
    drop(session);
    drop(subscription);

    let result = finalise_outcome(outcome, &mut entry, config.verbose, &mut io::stdout()).await;

    // The child entry persists only its own turns: the ancestor chain is
    // already on disk in the parent entries (O(D), not O(D²)).
    let keep_from = continuation_len.min(entry.turns.len());
    entry.turns.drain(..keep_from);
    // Logging never breaks the tool.
    let _ = append_log_entry(&home, &mut entry);
    result
}

/// The model's last proposed command, for `final` turns of outcomes that
/// did not run one. Walks assistant turns only: a step's `command` may be
/// the user's edit, and this records what the model proposed.
fn last_proposed_command(entry: &LogEntry) -> String {
    entry
        .turns
        .iter()
        .rev()
        .find_map(|turn| match turn {
            Turn::Assistant {
                response: Some(response),
                ..
            } if response.kind == ResponseType::Command => Some(response.content.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn final_turn(command: String, source: &str) -> Turn {
    Turn::Final {
        command,
        exit_code: None,
        shell: None,
        source: source.to_string(),
        exec_ms: None,
    }
}

/// Act on the session's outcome: print, run, or report; record the `final`
/// turn and the entry's outcome; return the exit code. An error outcome
/// returns `Err(message)` so the caller prints it after the log is written.
pub async fn finalise_outcome(
    outcome: SessionOutcome,
    entry: &mut LogEntry,
    verbose_on: bool,
    stdout: &mut dyn Write,
) -> Result<i32, String> {
    match outcome {
        SessionOutcome::Answer(content) => {
            // Pure-answer sessions have no `final` turn; the last assistant
            // turn carries the reply.
            let _ = writeln!(stdout, "{content}");
            let _ = stdout.flush();
            entry.outcome = "success".to_string();
            Ok(0)
        }
        SessionOutcome::Exhausted => {
            let proposed = last_proposed_command(entry);
            entry.turns.push(final_turn(proposed, "exhausted"));
            let rounds_used = entry
                .turns
                .iter()
                .filter(|t| matches!(t, Turn::Assistant { .. }))
                .count();
            chrome::chrome(
                &format!("Could not resolve the request within {rounds_used} rounds."),
                None,
            );
            entry.outcome = "max_rounds".to_string();
            Ok(1)
        }
        SessionOutcome::Blocked { command, .. } => {
            entry.turns.push(final_turn(command, "blocked"));
            entry.outcome = "blocked".to_string();
            Ok(1)
        }
        SessionOutcome::Cancel { response } => {
            let command = response
                .map(|r| r.content)
                .unwrap_or_else(|| last_proposed_command(entry));
            entry.turns.push(final_turn(command, "cancelled"));
            entry.outcome = "cancelled".to_string();
            Ok(0)
        }
        SessionOutcome::Error(message) => {
            entry
                .turns
                .push(final_turn(last_proposed_command(entry), "error"));
            entry.outcome = "error".to_string();
            Err(message)
        }
        SessionOutcome::Run {
            command, source, ..
        } => {
            verbose(verbose_on, &format!("Running: {command}"));
            let exec = execute_shell_command(&command, ShellMode::Inherit, None)
                .await
                .map_err(|e| format!("Could not run the command: {e}"))?;
            entry.turns.push(Turn::Final {
                command,
                exit_code: Some(exec.exit_code),
                shell: Some(exec.shell),
                source: source.as_str().to_string(),
                exec_ms: Some(exec.exec_ms),
            });
            verbose(verbose_on, &format!("Command exited ({})", exec.exit_code));
            entry.outcome = if exec.exit_code == 0 {
                "success".to_string()
            } else {
                "error".to_string()
            };
            Ok(exec.exit_code)
        }
    }
}
