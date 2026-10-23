//! The round loop: drives rounds until a final-form response, exhaustion or
//! cancellation, executing non-final low-risk steps inline and reporting
//! lifecycle events to the coordinator.

use std::path::{Path, PathBuf};

use regex::Regex;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use super::round::{AssistantTurn, RoundError, RoundOptions, run_round};
use super::state::LoopReturn;
use crate::attached_input::truncate_middle;
use crate::chrome::{chrome, verbose};
use crate::config::ResolvedConfig;
use crate::home::WrapHome;
use crate::llm::Conversation;
use crate::logging::Turn;
use crate::memory::append_facts;
use crate::paths::{pretty_path, resolve_path};
use crate::prompt::TurnFramer;
use crate::response::{CommandResponse, ResponseType, RiskLevel};
use crate::shell::{ShellMode, execute_shell_command};
use crate::watchlist::add_to_watchlist;

/// The session's conversation record: the semantic turns (which become the
/// log entry's `turns`) and the live conversation they are framed into.
/// `append_turn` is the one gate where a non-assistant turn lands on both;
/// assistant turns only join `turns`, their echo having entered the
/// conversation through the send itself.
pub struct Transcript {
    pub chat: Conversation,
    framer: TurnFramer,
    pub turns: Vec<Turn>,
}

impl Transcript {
    pub fn new(chat: Conversation, framer: TurnFramer) -> Transcript {
        Transcript {
            chat,
            framer,
            turns: Vec::new(),
        }
    }

    pub fn append_turn(&mut self, turn: Turn) {
        for message in self.framer.frame(&turn) {
            self.chat.add(message, false);
        }
        self.turns.push(turn);
    }

    pub fn push_assistant(&mut self, turn: AssistantTurn) {
        self.turns.push(turn.into());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopState {
    /// Remaining round budget; reset by the coordinator on every new loop.
    pub budget_remaining: u32,
    /// Monotonic round counter across the whole session.
    pub round_num: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LoopEvent {
    /// A round settled (successfully or not) and its turn is on the
    /// transcript. The coordinator only observes.
    AssistantTurn { turn: Turn },
    /// A non-final step is about to run; the consumer shows `explanation`
    /// as chrome.
    StepRunning { explanation: String, icon: String },
    /// A step finished; `text` is the truncated output fed back to the model.
    StepOutput { text: String },
}

pub struct LoopOptions {
    pub cwd: PathBuf,
    /// Provider label, e.g. `anthropic / claude-sonnet-4-6`.
    pub label: String,
    pub home: WrapHome,
    pub config: ResolvedConfig,
    /// Stderr spinner around each call; off while a dialog is mounted.
    pub show_spinner: bool,
    pub cancel: CancellationToken,
    pub events: UnboundedSender<LoopEvent>,
}

/// URL-fetching steps show 🌐 instead of 🔍.
pub fn fetches_url(content: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"^\s*(curl|wget)\b[^\n]*https?://").expect("valid regex"))
        .is_match(content)
}

/// Captured stdout and stderr merged for the model, on separate lines, within
/// the configured character budget.
pub fn merge_step_output(stdout: &str, stderr: &str, max_chars: usize) -> String {
    let mut output = stdout.to_string();
    if !stderr.trim().is_empty() {
        if !output.trim().is_empty() {
            output.push('\n');
        }
        output.push_str(stderr);
    }
    truncate_middle(&output, max_chars)
}

fn handle_memory_updates(
    response: &CommandResponse,
    home: &WrapHome,
    cwd: &Path,
    verbose_on: bool,
) -> Result<(), String> {
    let Some(updates) = response.memory_updates.as_ref().filter(|u| !u.is_empty()) else {
        return Ok(());
    };
    append_facts(home, updates, cwd)?;
    verbose(
        verbose_on,
        &format!("Memory updated: {} facts", updates.len()),
    );
    if let Some(message) = &response.memory_updates_message {
        let deepest = updates
            .iter()
            .filter_map(|u| resolve_path(&u.scope, Some(cwd)))
            .filter(|p| p != Path::new("/"))
            .max_by_key(|p| p.as_os_str().len());
        let text = match deepest {
            Some(scope) => format!("({}) {message}", pretty_path(scope)),
            None => message.clone(),
        };
        chrome(&text, Some("🧠"));
    }
    Ok(())
}

/// Drive rounds until a final-form response, exhaustion or cancellation.
///
/// Per iteration: bail if cancelled; run a round; push its assistant turn
/// (or the partial turn of a failed round, before surfacing the error);
/// apply memory and watchlist side effects; then route by response shape:
/// a reply returns the answer, a final command (any risk) or a non-final
/// medium/high command returns to the coordinator, and a non-final low
/// (any risk under yolo) runs inline in capture mode, lands as a step turn,
/// and continues. A non-final response on the last round is exhaustion.
///
/// The cancel token is re-checked after every await so a loop the user
/// walked away from never pushes a turn.
pub async fn run_loop(
    transcript: &mut Transcript,
    state: &mut LoopState,
    options: &LoopOptions,
) -> Result<LoopReturn, String> {
    let config = &options.config;
    let verbose_on = config.verbose;
    while state.budget_remaining > 0 {
        if options.cancel.is_cancelled() {
            return Ok(LoopReturn::Aborted);
        }
        state.round_num += 1;
        state.budget_remaining -= 1;
        // Zero after the decrement marks the last round of this loop; a
        // budget reset by a follow-up makes it true again later, which is
        // right where comparing `round_num` to `max_rounds` would not be.
        let is_last_round = state.budget_remaining == 0;

        if state.round_num > 1 {
            verbose(
                verbose_on,
                &format!("Round {}/{}", state.round_num, config.max_rounds),
            );
        }
        if is_last_round {
            verbose(verbose_on, "Final round: must return command or answer");
        }
        verbose(verbose_on, &format!("Calling {}...", options.label));

        let turn = match run_round(
            &mut transcript.chat,
            RoundOptions {
                is_last_round,
                label: options.label.clone(),
                show_spinner: options.show_spinner,
                cancel: Some(options.cancel.clone()),
                log_traces: config.log_traces,
                verbose: verbose_on,
                no_animation: config.no_animation,
            },
        )
        .await
        {
            Ok(turn) => turn,
            // An aborted send leaves no turn: the record never shows the
            // round the user walked away from.
            Err(RoundError::Aborted) => return Ok(LoopReturn::Aborted),
            Err(RoundError::Failed { message, turn }) => {
                let turn = *turn;
                transcript.push_assistant(turn.clone());
                let _ = options
                    .events
                    .send(LoopEvent::AssistantTurn { turn: turn.into() });
                return Err(message);
            }
        };
        if options.cancel.is_cancelled() {
            return Ok(LoopReturn::Aborted);
        }

        let response = turn
            .response
            .clone()
            .ok_or_else(|| "The LLM round settled without a response.".to_string())?;
        transcript.push_assistant(turn.clone());
        let _ = options
            .events
            .send(LoopEvent::AssistantTurn { turn: turn.into() });

        handle_memory_updates(&response, &options.home, &options.cwd, verbose_on)?;
        if let Some(tools) = response
            .watchlist_additions
            .as_ref()
            .filter(|t| !t.is_empty())
        {
            add_to_watchlist(&options.home, tools)
                .map_err(|e| format!("Could not update the tool watchlist: {e}"))?;
            verbose(
                verbose_on,
                &format!("Watchlist: added {}", tools.join(", ")),
            );
        }

        if response.kind == ResponseType::Reply {
            return Ok(LoopReturn::Answer(response.content));
        }

        // Yolo broadens the inline step to any risk: the user opted out of
        // the gate.
        let can_inline_step =
            !response.is_final && (response.risk_level == RiskLevel::Low || config.yolo);
        if !can_inline_step {
            return Ok(LoopReturn::Command(response));
        }
        // The last-round instruction forbids `final: false`; a model that
        // ignored it stops here without running the step.
        if is_last_round {
            return Ok(LoopReturn::Exhausted);
        }

        let icon = if fetches_url(&response.content) {
            "🌐"
        } else {
            "🔍"
        };
        let explanation = response
            .explanation
            .clone()
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| response.content.clone());
        let _ = options.events.send(LoopEvent::StepRunning {
            explanation,
            icon: icon.to_string(),
        });
        verbose(verbose_on, &format!("Step: {}", response.content));

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
        verbose(verbose_on, &format!("Step exited ({})", exec.exit_code));

        let output =
            merge_step_output(&exec.stdout, &exec.stderr, config.max_captured_output_chars);
        let _ = options.events.send(LoopEvent::StepOutput {
            text: output.clone(),
        });
        transcript.append_turn(Turn::Step {
            command: response.content,
            exit_code: exec.exit_code,
            output,
            shell: exec.shell,
            source: "model".to_string(),
            exec_ms: Some(exec.exec_ms),
        });
    }
    Ok(LoopReturn::Exhausted)
}
