//! One LLM round on the session's conversation: the per-round transient
//! directives, the send (with the conversation's own parse retry inside),
//! the scratchpad domain retry, and the assistant turn derived from the
//! conversation record afterwards.

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::chrome::{SPINNER_TEXT, start_chrome_spinner, verbose, verbose_highlight};
use crate::llm::{
    Attempt, AttemptErrorKind as LlmAttemptErrorKind, Conversation, Entry, LlmError, LlmMessage,
    Role, SendOptions,
};
use crate::logging::{AttemptError, AttemptErrorKind, AttemptMeta, LoggedRequest, Turn};
use crate::prompt::{constants, echo_text, is_scratchpad_rejected};
use crate::response::{CommandResponse, ResponseType, command_response_json_schema};
use crate::temp::format_temp_dir_section_from_env;

#[derive(Clone, Debug, Default)]
pub struct RoundOptions {
    pub is_last_round: bool,
    /// Provider label for the error message, e.g. `anthropic / claude-sonnet-4-6`.
    pub label: String,
    /// Show the stderr spinner around the call. Off while a dialog is up: the
    /// dialog's own bottom-border spinner reports the same thing.
    pub show_spinner: bool,
    pub cancel: Option<CancellationToken>,
    pub log_traces: bool,
    pub verbose: bool,
    pub no_animation: bool,
}

/// One round's record before it joins the transcript as [`Turn::Assistant`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AssistantTurn {
    pub response: Option<CommandResponse>,
    pub attempts: Vec<AttemptMeta>,
    pub llm_ms: Option<u64>,
}

impl From<AssistantTurn> for Turn {
    fn from(turn: AssistantTurn) -> Turn {
        Turn::Assistant {
            response: turn.response,
            attempts: turn.attempts,
            llm_ms: turn.llm_ms,
            source: "model".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RoundError {
    /// The round failed after enough of a turn existed to log. `turn` is the
    /// partial record the loop pushes before surfacing `message`.
    Failed {
        message: String,
        turn: Box<AssistantTurn>,
    },
    /// The cancel token fired; the round leaves no turn.
    Aborted,
}

fn verbose_response(response: &CommandResponse, enabled: bool) {
    if let Some(scratchpad) = &response.scratchpad {
        verbose_highlight(
            enabled,
            "LLM scratchpad: ",
            &scratchpad.replace('\n', " \\n "),
        );
    }
    match response.kind {
        ResponseType::Command => {
            let tag = if response.is_final { "command" } else { "step" };
            let risk = serde_json::to_value(response.risk_level)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            verbose_highlight(
                enabled,
                &format!("LLM responded ({tag}, {risk}): "),
                &response.content,
            );
        }
        ResponseType::Reply => verbose(
            enabled,
            &format!(
                "LLM responded (reply, {} chars)",
                response.content.chars().count()
            ),
        ),
    }
}

/// The rejected response exactly as the model should see it: with
/// `_scratchpad` spelled out as null so it knows what to fix.
fn raw_rejected_json(response: &CommandResponse) -> String {
    let mut object = Map::new();
    object.insert("_scratchpad".to_string(), Value::Null);
    if let Ok(Value::Object(fields)) = serde_json::to_value(response) {
        for (key, value) in fields {
            object.entry(key).or_insert(value);
        }
    }
    Value::Object(object).to_string()
}

fn transient(chat: &mut Conversation, role: Role, content: String) {
    chat.add(LlmMessage { role, content }, true);
}

/// This round's per-call directives as ordered transient adds: the live
/// temp-dir listing, then (on the scratchpad retry) the raw rejected JSON as
/// an assistant/user echo pair, then the last-round instruction. The send
/// they precede consumes them, so the retry re-adds whatever still applies.
fn add_round_directives(
    chat: &mut Conversation,
    live_context: &str,
    is_last_round: bool,
    scratchpad_rejected: Option<&CommandResponse>,
) {
    let c = constants();
    transient(chat, Role::User, live_context.to_string());
    if let Some(rejected) = scratchpad_rejected {
        transient(chat, Role::Assistant, raw_rejected_json(rejected));
        transient(chat, Role::User, c.scratchpad_required_instruction.clone());
    }
    if is_last_round {
        transient(chat, Role::User, c.last_round_instruction.clone());
    }
}

/// The settled echo, added explicitly when the predicate rejected the
/// response but the round accepted it anyway.
fn add_settled_echo(chat: &mut Conversation, response: &CommandResponse) {
    chat.add(
        LlmMessage {
            role: Role::Assistant,
            content: echo_text(response),
        },
        false,
    );
}

/// `parsed` lands on the error-free attempt of a send; `raw_response` is
/// always kept on a parse failure and otherwise only under `log_traces`,
/// along with the request and wires.
fn to_attempt_meta(attempt: &Attempt, parsed: Option<&Value>, log_traces: bool) -> AttemptMeta {
    let mut meta = AttemptMeta::default();
    if attempt.error.is_none()
        && let Some(parsed) = parsed
    {
        meta.parsed = serde_json::from_value(parsed.clone()).ok();
    }
    if log_traces {
        meta.request = Some(LoggedRequest {
            system: attempt.request.system.clone(),
            messages: attempt.request.messages.clone(),
        });
        meta.request_wire = attempt.request_wire.clone();
        meta.response_wire = attempt.response_wire.clone();
        meta.raw_response = attempt.raw_text.clone();
    }
    if let Some(error) = &attempt.error {
        meta.error = Some(AttemptError {
            kind: match error.kind {
                LlmAttemptErrorKind::Parse => AttemptErrorKind::Parse,
                LlmAttemptErrorKind::Provider => AttemptErrorKind::Provider,
            },
            message: error.message.clone(),
        });
        if error.kind == LlmAttemptErrorKind::Parse {
            meta.raw_response = attempt.raw_text.clone();
        }
    }
    meta.llm_ms = Some(attempt.duration_ms);
    meta
}

/// Flatten the round's send-produced entries into one attempts list.
fn derive_attempts(entries: &[Entry], log_traces: bool) -> (Vec<AttemptMeta>, u64) {
    let mut attempts = Vec::new();
    let mut total_ms = 0;
    for entry in entries {
        for attempt in &entry.attempts {
            attempts.push(to_attempt_meta(attempt, entry.parsed.as_ref(), log_traces));
            total_ms += attempt.duration_ms;
        }
    }
    (attempts, total_ms)
}

fn is_cancelled(cancel: &Option<CancellationToken>) -> bool {
    cancel.as_ref().is_some_and(|c| c.is_cancelled())
}

/// Run one round: up to two sends (initial + scratchpad retry), each with
/// the conversation's single parse retry inside, all merged into one
/// assistant turn.
///
/// A schema-valid high-risk command without a scratchpad is echo-rejected by
/// the predicate, so nothing replayable landed; the round re-adds the
/// transients plus the raw rejected JSON as an echo pair and sends again. A
/// filled second response echoes via the predicate; a still-null one is
/// accepted without a third call and settled explicitly, and a second send
/// that fails to parse keeps response #1 (settled explicitly) with the failed
/// attempts on the record. A provider failure mid-retry fails the round with
/// response #1 on the partial turn.
pub async fn run_round(
    chat: &mut Conversation,
    options: RoundOptions,
) -> Result<AssistantTurn, RoundError> {
    let _spinner = options
        .show_spinner
        .then(|| start_chrome_spinner(SPINNER_TEXT, options.no_animation));
    let start = chat.entries().len();
    let fail = |chat: &Conversation, response: Option<CommandResponse>, message: String| {
        verbose(options.verbose, &format!("LLM error: {message}"));
        let (attempts, total_ms) = derive_attempts(&chat.entries()[start..], options.log_traces);
        RoundError::Failed {
            message: format!("LLM error ({}): {message}", options.label),
            turn: Box::new(AssistantTurn {
                response,
                attempts,
                llm_ms: Some(total_ms),
            }),
        }
    };

    // A send on an already-cancelled token never starts and never consumes,
    // so the transients would leak into the next round's assembly.
    if is_cancelled(&options.cancel) {
        return Err(RoundError::Aborted);
    }
    let live_context = format_temp_dir_section_from_env();
    add_round_directives(chat, &live_context, options.is_last_round, None);
    let send_options = SendOptions {
        cancel: options.cancel.clone(),
        retry: true,
    };
    let schema = command_response_json_schema();

    let mut response: CommandResponse = match chat.send(schema, send_options.clone()).await {
        Ok(response) => response,
        Err(LlmError::Aborted) => return Err(RoundError::Aborted),
        Err(error) => return Err(fail(chat, None, error.to_string())),
    };

    if is_scratchpad_rejected(&response) {
        if is_cancelled(&options.cancel) {
            return Err(RoundError::Aborted);
        }
        add_round_directives(chat, &live_context, options.is_last_round, Some(&response));
        match chat.send::<CommandResponse>(schema, send_options).await {
            Ok(second) => {
                if is_scratchpad_rejected(&second) {
                    add_settled_echo(chat, &second);
                }
                response = second;
            }
            Err(LlmError::Aborted) => return Err(RoundError::Aborted),
            Err(LlmError::Parse { .. }) => add_settled_echo(chat, &response),
            Err(error) => return Err(fail(chat, Some(response), error.to_string())),
        }
    }

    verbose_response(&response, options.verbose);
    let (mut attempts, total_ms) = derive_attempts(&chat.entries()[start..], options.log_traces);

    if response.content.trim().is_empty() {
        const MESSAGE: &str = "LLM returned an empty response.";
        if let Some(last) = attempts.last_mut() {
            last.error = Some(AttemptError {
                kind: AttemptErrorKind::Empty,
                message: MESSAGE.to_string(),
            });
        }
        return Err(RoundError::Failed {
            message: MESSAGE.to_string(),
            turn: Box::new(AssistantTurn {
                response: Some(response),
                attempts,
                llm_ms: Some(total_ms),
            }),
        });
    }

    Ok(AssistantTurn {
        response: Some(response),
        attempts,
        llm_ms: Some(total_ms),
    })
}
