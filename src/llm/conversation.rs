//! Conversation state and the send engine: an append-only entry record,
//! transients consumed by the send they precede, exactly one corrective
//! parse retry, and abort that seals the entry with no replayable message.

use super::errors::{LlmError, ParseReason};
use super::provider::{Provider, ProviderRequest};
use super::wires::{WireRequest, WireResponse};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// A single conversation message. The system prompt is conversation-level
/// configuration, never an entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: Role,
    pub content: String,
}

/// The assembled request behind one physical call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttemptRequest {
    pub system: String,
    pub messages: Vec<LlmMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
}

/// `Parse`: the reply could not become a schema-valid value. `Provider`:
/// the transport failed before a usable reply existed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptErrorKind {
    Parse,
    Provider,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptError {
    pub kind: AttemptErrorKind,
    pub message: String,
}

/// One physical call's record. Wires are scrubbed before they land here,
/// so persisting entries never persists a key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attempt {
    pub request: AttemptRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_wire: Option<WireRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_wire: Option<WireResponse>,
    /// The model's reply text, verbatim; absent when the call never settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AttemptError>,
}

/// One annotated entry. `message: None` means not replayable: failed,
/// aborted, and echo-rejected sends keep their forensics without polluting
/// the next assembly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub message: Option<LlmMessage>,
    /// Sent with at most one send, then retained as consumed.
    #[serde(default)]
    pub transient: bool,
    #[serde(default)]
    pub consumed: bool,
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    /// Validated result on successful sends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parsed: Option<Value>,
}

/// An entry re-enters a fresh conversation iff it carries a message and is
/// not a consumed transient.
pub fn replayable(entry: &Entry) -> bool {
    entry.message.is_some() && !(entry.transient && entry.consumed)
}

/// Decides what the model sees echoed back as the assistant turn after a
/// schema-valid send. `None` records the entry with no replayable message.
pub type EchoPredicate = Arc<dyn Fn(&Value, &str) -> Option<String> + Send + Sync>;

pub struct ConversationOptions {
    pub system: String,
    /// Defaults to echoing the raw text verbatim.
    pub format_echo: Option<EchoPredicate>,
}

#[derive(Clone, Debug)]
pub struct SendOptions {
    /// Cancelling seals the entry (attempts so far, no replayable message)
    /// and returns [`LlmError::Aborted`]; the transport is dropped.
    pub cancel: Option<CancellationToken>,
    /// Exactly one corrective retry on parse failure when true.
    pub retry: bool,
}

impl Default for SendOptions {
    fn default() -> Self {
        Self {
            cancel: None,
            retry: true,
        }
    }
}

pub struct Conversation {
    provider: Arc<Provider>,
    system: String,
    format_echo: Option<EchoPredicate>,
    entries: Vec<Entry>,
}

/// Strip markdown fences only when the entire response is one fenced block:
/// an opening fence with an optional word tag on its own line, the body, and
/// a closing fence on its own line. Anything looser (a non-word tag, a
/// closing fence glued to the body, more fences inside) stays verbatim and
/// fails to parse, which triggers the corrective retry.
fn strip_fences(text: &str) -> &str {
    static FENCE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let fence = FENCE.get_or_init(|| {
        regex::Regex::new(r"(?s)^```[0-9A-Za-z_]*\s*\n(.*)\n```$").expect("valid regex")
    });
    let trimmed = text.trim();
    fence
        .captures(trimmed)
        .map(|caps| caps.get(1).expect("group 1").as_str())
        .filter(|inner| !inner.contains("```"))
        .map(str::trim)
        .unwrap_or(trimmed)
}

/// Fence-strip, then JSON, then schema. Classification lives here, not in
/// providers.
fn parse_reply<T: DeserializeOwned>(raw: &str) -> Result<(Value, T), (String, ParseReason)> {
    let value: Value = serde_json::from_str(strip_fences(raw)).map_err(|_| {
        (
            "Model response was not valid JSON.".to_string(),
            ParseReason::InvalidJson,
        )
    })?;
    let typed: T = serde_json::from_value(value.clone()).map_err(|_| {
        (
            "Model response did not match the expected schema.".to_string(),
            ParseReason::InvalidSchema,
        )
    })?;
    Ok((value, typed))
}

impl Conversation {
    pub(crate) fn new(provider: Arc<Provider>, options: ConversationOptions) -> Self {
        Self {
            provider,
            system: options.system,
            format_echo: options.format_echo,
            entries: Vec::new(),
        }
    }

    /// The only way messages enter a conversation.
    pub fn add(&mut self, message: LlmMessage, transient: bool) {
        self.entries.push(Entry {
            message: Some(message),
            transient,
            consumed: false,
            attempts: Vec::new(),
            parsed: None,
        });
    }

    /// The annotated, append-only conversation record.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Snapshot the messages a send carries and mark included transients
    /// consumed, so at-most-one-send holds whether the send settles or not.
    fn begin_send(&mut self) -> Vec<LlmMessage> {
        let mut messages = Vec::new();
        for entry in &mut self.entries {
            if entry.consumed {
                continue;
            }
            let Some(message) = &entry.message else {
                continue;
            };
            messages.push(message.clone());
            if entry.transient {
                entry.consumed = true;
            }
        }
        messages
    }

    /// One structured send. The top-level schema must be object-shaped.
    pub async fn send<T: DeserializeOwned>(
        &mut self,
        schema: &Value,
        opts: SendOptions,
    ) -> Result<T, LlmError> {
        let cancel = opts.cancel.clone().unwrap_or_default();
        // An already-fired token means the send never starts: no transient
        // consumption, no entry.
        if cancel.is_cancelled() {
            return Err(LlmError::Aborted);
        }
        let base = self.begin_send();
        let mut attempts: Vec<Attempt> = Vec::new();
        let outcome = {
            let work = run_send::<T>(
                &self.provider,
                &self.system,
                base,
                schema,
                opts.retry,
                &mut attempts,
            );
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(LlmError::Aborted),
                result = work => result,
            }
        };
        let (message, parsed, result) = match outcome {
            Ok((value, typed, raw)) => {
                let echoed = match &self.format_echo {
                    Some(format) => format(&value, &raw),
                    None => Some(raw),
                };
                let message = echoed.map(|content| LlmMessage {
                    role: Role::Assistant,
                    content,
                });
                (message, Some(value), Ok(typed))
            }
            Err(error) => (None, None, Err(error)),
        };
        self.entries.push(Entry {
            message,
            transient: false,
            consumed: false,
            attempts,
            parsed,
        });
        result
    }
}

/// One physical call, appended to `attempts` once settled. A dropped
/// (aborted) call leaves no half-written attempt behind.
async fn physical_call(
    provider: &Provider,
    system: &str,
    messages: Vec<LlmMessage>,
    schema: &Value,
    attempts: &mut Vec<Attempt>,
) -> Result<String, LlmError> {
    let started = Instant::now();
    let result = provider
        .call(ProviderRequest {
            system,
            messages: &messages,
            schema,
        })
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let secrets = provider.secrets();
    let request = AttemptRequest {
        system: system.to_string(),
        messages,
        schema: Some(schema.clone()),
    };
    match result {
        Ok(reply) => {
            attempts.push(Attempt {
                request,
                request_wire: reply.request_wire.map(|w| w.scrubbed(secrets)),
                response_wire: reply.response_wire.map(|w| w.scrubbed(secrets)),
                raw_text: Some(reply.text.clone()),
                duration_ms,
                error: None,
            });
            Ok(reply.text)
        }
        Err(error) => {
            let error = *error;
            // An HTTP 401 body can quote the key into the message, so the
            // message is scrubbed everywhere it travels.
            let message = super::wires::scrub_text(&error.message, secrets);
            attempts.push(Attempt {
                request,
                request_wire: error.request_wire.map(|w| w.scrubbed(secrets)),
                response_wire: error.response_wire.map(|w| w.scrubbed(secrets)),
                raw_text: None,
                duration_ms,
                error: Some(AttemptError {
                    kind: AttemptErrorKind::Provider,
                    message: message.clone(),
                }),
            });
            Err(LlmError::Provider { message })
        }
    }
}

fn mark_parse_failure(attempts: &mut [Attempt], message: &str) {
    if let Some(last) = attempts.last_mut() {
        last.error = Some(AttemptError {
            kind: AttemptErrorKind::Parse,
            message: message.to_string(),
        });
    }
}

async fn run_send<T: DeserializeOwned>(
    provider: &Provider,
    system: &str,
    base: Vec<LlmMessage>,
    schema: &Value,
    retry: bool,
    attempts: &mut Vec<Attempt>,
) -> Result<(Value, T, String), LlmError> {
    let raw = physical_call(provider, system, base.clone(), schema, attempts).await?;
    let (message, reason) = match parse_reply::<T>(&raw) {
        Ok((value, typed)) => return Ok((value, typed, raw)),
        Err(failure) => failure,
    };
    mark_parse_failure(attempts, &message);
    if !retry {
        return Err(LlmError::Parse {
            message,
            raw_text: raw,
            reason,
        });
    }

    // Exactly one corrective retry: the same assembly, the failed text echoed
    // verbatim, and the corrective instruction. The pair exists only in the
    // second attempt's forensics, never in entries.
    let mut retry_messages = base;
    retry_messages.push(LlmMessage {
        role: Role::Assistant,
        content: raw,
    });
    retry_messages.push(LlmMessage {
        role: Role::User,
        content: crate::prompt::constants().json_retry_instruction.clone(),
    });
    let raw = physical_call(provider, system, retry_messages, schema, attempts).await?;
    match parse_reply::<T>(&raw) {
        Ok((value, typed)) => Ok((value, typed, raw)),
        Err((message, reason)) => {
            mark_parse_failure(attempts, &message);
            Err(LlmError::Parse {
                message,
                raw_text: raw,
                reason,
            })
        }
    }
}
