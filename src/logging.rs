//! The invocation record: one JSONL line per run in `logs/wrap.jsonl`, with
//! wire-level traces split into `logs/traces/<id>.json` sidecars, and the
//! lookups that `-c` uses to find and replay a previous conversation.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;

use serde::{Deserialize, Serialize};

pub use crate::config::ResolvedProvider;
use crate::home::WrapHome;
pub use crate::llm::{LlmMessage, Role, WireRequest, WireResponse};
use crate::memory::Memory;
pub use crate::response::{CommandResponse, ResponseType, RiskLevel};

const LOG_FILE: &str = "logs/wrap.jsonl";
const LOG_PREVIEW_MAX_CHARS: usize = 1000;

/// The assembled request of a traced attempt: system text plus every
/// message sent. Only present under `logTraces`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoggedRequest {
    pub system: String,
    pub messages: Vec<LlmMessage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptErrorKind {
    Parse,
    Provider,
    Empty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptError {
    pub kind: AttemptErrorKind,
    pub message: String,
}

/// One physical LLM call inside an assistant turn. `request`,
/// `request_wire` and `response_wire` only appear under `logTraces` and are
/// moved to the trace sidecar at write time; `raw_response` stays inline
/// when it is the breadcrumb of a parse failure.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AttemptMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parsed: Option<CommandResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<LoggedRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_wire: Option<WireRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_response: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_wire: Option<WireResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AttemptError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_ms: Option<u64>,
}

impl AttemptMeta {
    fn is_traced(&self) -> bool {
        self.request.is_some() || self.request_wire.is_some() || self.response_wire.is_some()
    }
}

/// A skill-emitted probe before it joins the transcript as [`Turn::Probe`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeTurn {
    pub skill: String,
    pub command: String,
    pub output: String,
}

impl From<ProbeTurn> for Turn {
    fn from(probe: ProbeTurn) -> Turn {
        Turn::Probe {
            skill: probe.skill,
            command: probe.command,
            output: probe.output,
        }
    }
}

/// One semantic conversation turn. The entry's `turns` and the runtime
/// transcript are the same list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Turn {
    /// The initial query or a follow-up, stored as bare text; framing is
    /// applied when the turn enters the live conversation, never stored.
    User { text: String },
    /// One LLM round. `response` is the last successful parse (absent when
    /// every attempt failed); `attempts` lists every physical call.
    Assistant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<CommandResponse>,
        #[serde(default)]
        attempts: Vec<AttemptMeta>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        llm_ms: Option<u64>,
        /// `model`
        source: String,
    },
    /// A non-final execution; `output` is the truncated captured stdout+stderr.
    Step {
        command: String,
        exit_code: i32,
        output: String,
        shell: String,
        /// `model` | `user_override`
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exec_ms: Option<u64>,
    },
    /// A skill probe: command plus captured output in one record.
    Probe {
        skill: String,
        command: String,
        output: String,
    },
    /// The session's outcome; `exit_code` is null unless something ran.
    Final {
        command: String,
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        /// `model` | `user_override` | `cancelled` | `blocked` | `exhausted` | `error`
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exec_ms: Option<u64>,
    },
}

/// Piped stdin as recorded in the log. `path` is ephemeral; `size` is the raw
/// byte count; `preview` is decoded text capped at 1000 chars.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachedInputRecord {
    pub path: String,
    pub size: u64,
    pub preview: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub version: String,
    pub cwd: String,
    /// The parent process id at session start.
    #[serde(default)]
    pub ppid: u32,
    pub provider: ResolvedProvider,
    pub prompt_hash: String,
    #[serde(default)]
    pub turns: Vec<Turn>,
    /// `success` | `error` | `blocked` | `cancelled` | `max_rounds`
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_input: Option<AttachedInputRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<Memory>,
    /// `argv` | `pipe` | `tui`; absent in older entries (treat as `argv`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_source: Option<String>,
    /// Set when this entry resumes another via `-c`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachedInputParams {
    pub path: String,
    pub size: u64,
    pub preview: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LogEntryParams {
    pub cwd: String,
    pub attached_input: Option<AttachedInputParams>,
    pub memory: Option<Memory>,
    pub provider: ResolvedProvider,
    pub prompt_hash: String,
    pub input_source: Option<String>,
    /// Override for the real parent process id (tests only).
    pub ppid: Option<u32>,
}

impl LogEntry {
    /// A fresh entry: new id, current time, outcome `error` until the session
    /// settles, API key redacted to its last four characters.
    pub fn create(params: LogEntryParams) -> LogEntry {
        LogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            version: env!("CARGO_PKG_VERSION").to_string(),
            cwd: params.cwd,
            ppid: params
                .ppid
                .unwrap_or_else(std::os::unix::process::parent_id),
            provider: redact_provider(params.provider),
            prompt_hash: params.prompt_hash,
            turns: Vec::new(),
            outcome: "error".to_string(),
            attached_input: params.attached_input.map(|input| AttachedInputRecord {
                path: input.path,
                size: input.size,
                preview: truncate_preview(&input.preview),
            }),
            memory: params.memory.filter(|m| !m.is_empty()),
            input_source: params.input_source,
            parent_id: None,
        }
    }

    /// The entry as one JSONL line (no trailing newline).
    pub fn to_jsonl_line(&self) -> String {
        serde_json::to_string(self).expect("log entry serializes")
    }
}

pub fn create_log_entry(params: LogEntryParams) -> LogEntry {
    LogEntry::create(params)
}

fn redact_provider(mut provider: ResolvedProvider) -> ResolvedProvider {
    if let Some(key) = provider.api_key.as_deref() {
        let chars: Vec<char> = key.chars().collect();
        let suffix: String = if chars.len() >= 4 {
            chars[chars.len() - 4..].iter().collect()
        } else {
            String::new()
        };
        provider.api_key = Some(format!("...{suffix}"));
    }
    provider
}

fn truncate_preview(preview: &str) -> String {
    let total = preview.chars().count();
    if total <= LOG_PREVIEW_MAX_CHARS {
        return preview.to_string();
    }
    let head: String = preview.chars().take(LOG_PREVIEW_MAX_CHARS).collect();
    format!("{head}\n[…truncated, {total} chars total]")
}

// --- writer ----------------------------------------------------------------

#[derive(Default, Serialize)]
struct TracedAttempt {
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<LoggedRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_wire: Option<WireRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_wire: Option<WireResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response: Option<String>,
}

#[derive(Serialize)]
struct TraceFile {
    entry_id: String,
    /// Keyed by turn index; only assistant turns carry attempts.
    turn_attempts: BTreeMap<usize, Vec<TracedAttempt>>,
}

// A parse-failure `raw_response` (no request, no wire) stays inline: that is
// the default-config breadcrumb for malformed model output.
fn extract_attempt_traces(attempt: &mut AttemptMeta) -> TracedAttempt {
    if !attempt.is_traced() {
        return TracedAttempt::default();
    }
    TracedAttempt {
        request: attempt.request.take(),
        request_wire: attempt.request_wire.take(),
        response_wire: attempt.response_wire.take(),
        raw_response: attempt.raw_response.take(),
    }
}

fn extract_traces(entry: &mut LogEntry) -> Option<TraceFile> {
    let mut turn_attempts = BTreeMap::new();
    for (index, turn) in entry.turns.iter_mut().enumerate() {
        let Turn::Assistant { attempts, .. } = turn else {
            continue;
        };
        if !attempts.iter().any(AttemptMeta::is_traced) {
            continue;
        }
        turn_attempts.insert(
            index,
            attempts.iter_mut().map(extract_attempt_traces).collect(),
        );
    }
    if turn_attempts.is_empty() {
        return None;
    }
    Some(TraceFile {
        entry_id: entry.id.clone(),
        turn_attempts,
    })
}

/// Append the entry to `logs/wrap.jsonl`, then write the trace sidecar when
/// any attempt carried `logTraces` fields. Those fields are stripped from
/// `entry` first so the JSONL stays lean. The JSONL line is written before
/// the sidecar, so a sidecar failure never costs the durable record.
pub fn append_log_entry(home: &WrapHome, entry: &mut LogEntry) -> io::Result<()> {
    let trace = extract_traces(entry);
    home.append(LOG_FILE, &format!("{}\n", entry.to_jsonl_line()))?;
    if let Some(trace) = trace {
        let json = serde_json::to_string(&trace).map_err(io::Error::other)?;
        home.write(&format!("logs/traces/{}.json", entry.id), &json)?;
    }
    Ok(())
}

// --- lookup ----------------------------------------------------------------

/// Every entry in the log, oldest first. Lines that do not parse are skipped:
/// logging never crashes the tool, even on read.
pub fn read_log_entries(home: &WrapHome) -> Vec<LogEntry> {
    let Ok(Some(content)) = home.read(LOG_FILE) else {
        return Vec::new();
    };
    content
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// The entry a `w -c` invocation resumes: the newest entry from the same
/// shell (matching `ppid`), else the newest overall. A caller ppid of 1 means
/// the process was reparented and cannot identify a shell, so it never matches.
pub fn find_continuation_parent(entries: &[LogEntry], ppid: u32) -> Option<&LogEntry> {
    if ppid != 1
        && let Some(same_shell) = entries.iter().rev().find(|e| e.ppid == ppid)
    {
        return Some(same_shell);
    }
    entries.last()
}

/// The turns of `parent` and all its ancestors, root first. A `parent_id`
/// that references a missing entry truncates the chain; a cycle stops at the
/// first repeated entry.
pub fn assemble_continuation_chain(entries: &[LogEntry], parent: &LogEntry) -> Vec<Turn> {
    let by_id: HashMap<&str, &LogEntry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut visited = HashSet::new();
    let mut chain = Vec::new();
    let mut current = Some(parent);
    while let Some(entry) = current {
        if !visited.insert(entry.id.as_str()) {
            break;
        }
        chain.push(entry);
        current = entry
            .parent_id
            .as_deref()
            .and_then(|id| by_id.get(id).copied());
    }
    chain
        .iter()
        .rev()
        .flat_map(|entry| entry.turns.iter().cloned())
        .collect()
}
