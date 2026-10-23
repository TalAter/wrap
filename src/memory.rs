//! Scoped facts about the user's environment, persisted in `memory.json`
//! as `{"<scope>": [{"fact": "…"}]}`. Scope `/` is global; any other scope is
//! the canonical directory the fact belongs to.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::home::WrapHome;
use crate::llm::{ConversationOptions, Llm, LlmError, LlmMessage, Role, SendOptions};
use crate::paths::{pretty_path, resolve_path};
pub use crate::response::MemoryUpdate;

const MEMORY_FILE: &str = "memory.json";

/// The init send has no dialog and no abort surface; without a bound a
/// stalled network would hang the first run forever.
pub const INIT_SEND_TIMEOUT: Duration = Duration::from_secs(120);

/// System prompt for the first-run memory initialisation send.
pub const INIT_SYSTEM_PROMPT: &str = "You are analyzing raw output from system probe commands. Parse the results into concise, human-readable facts about the user's environment.

Rules:
- Respond with JSON: {\"facts\": [\"...\", \"...\"]} — one string per fact, nothing outside the JSON object
- Infer implicit facts (e.g., Darwin → macOS, arm64 → Apple Silicon)
- Include: OS + version + architecture, shell + config file location
- Be concise — each fact a single short sentence
- Do not include facts that cannot be determined from the probe output";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub fact: String,
}

/// Scope → facts. Keys sort, which is also the on-disk order.
pub type Memory = BTreeMap<String, Vec<Fact>>;

pub fn count_facts(memory: &Memory) -> usize {
    memory.values().map(Vec::len).sum()
}

/// The OS's description of an I/O failure without the errno suffix.
fn io_reason(error: &std::io::Error) -> String {
    let text = error.to_string();
    text.split(" (os error").next().unwrap_or(&text).to_string()
}

fn memory_error(home: &WrapHome) -> String {
    format!(
        "Memory error: {} is broken — delete the file and run Wrap again.",
        pretty_path(home.resolve(MEMORY_FILE))
    )
}

/// Memory on disk; empty when the file does not exist. Fails with a
/// plain-language message when the file is unreadable or malformed.
pub fn load_memory(home: &WrapHome) -> Result<Memory, String> {
    let raw = home.read(MEMORY_FILE).map_err(|e| {
        format!(
            "Memory error: {} could not be read — {}.",
            pretty_path(home.resolve(MEMORY_FILE)),
            io_reason(&e)
        )
    })?;
    match raw {
        None => Ok(Memory::new()),
        Some(raw) => serde_json::from_str(&raw).map_err(|_| memory_error(home)),
    }
}

/// Write memory as pretty JSON with sorted scopes.
pub fn save_memory(home: &WrapHome, memory: &Memory) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(memory).map_err(std::io::Error::other)?;
    home.write(MEMORY_FILE, &json)
}

/// Append facts under their resolved scopes and persist. A scope that does
/// not resolve to an existing directory drops its fact; duplicates within a
/// scope are skipped.
pub fn append_facts(
    home: &WrapHome,
    updates: &[MemoryUpdate],
    cwd: &Path,
) -> Result<Memory, String> {
    let mut memory = load_memory(home)?;
    for update in updates {
        let Some(scope) = resolve_path(&update.scope, Some(cwd)) else {
            continue;
        };
        let facts = memory
            .entry(scope.to_string_lossy().into_owned())
            .or_default();
        if !facts.iter().any(|f| f.fact == update.fact) {
            facts.push(Fact {
                fact: update.fact.clone(),
            });
        }
    }
    save_memory(home, &memory)
        .map_err(|e| format!("Memory error: could not save memory — {}.", io_reason(&e)))?;
    Ok(memory)
}

// --- init probes -----------------------------------------------------------

pub struct ProbeCommand {
    pub label: &'static str,
    pub command: &'static str,
}

/// Probe commands whose output the init send turns into facts.
pub const PROBE_COMMANDS: &[ProbeCommand] = &[
    ProbeCommand {
        label: "OS",
        command: "uname -a",
    },
    ProbeCommand {
        label: "Shell",
        command: "echo $SHELL",
    },
    ProbeCommand {
        label: "Distro",
        command: "cat /etc/os-release 2>/dev/null || echo 'Not Linux'",
    },
    ProbeCommand {
        label: "Shell config files",
        command: "ls -la ~/.*shrc ~/.*sh_profile ~/.*profile ~/.config/fish/config.fish 2>/dev/null",
    },
];

/// Run every probe and join the results as `## Label` sections.
pub fn run_probes() -> String {
    PROBE_COMMANDS
        .iter()
        .map(|probe| {
            let output = Command::new("sh")
                .args(["-c", probe.command])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            let body = if output.is_empty() {
                "(no output)"
            } else {
                output.as_str()
            };
            format!("## {}\n{body}", probe.label)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// --- ensure_memory ---------------------------------------------------------

/// The typed shape of the init send.
#[derive(Debug, Deserialize)]
pub struct InitFacts {
    pub facts: Vec<String>,
}

/// JSON Schema the init send asks the provider to honour.
pub fn init_facts_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": { "facts": { "type": "array", "items": { "type": "string" } } },
        "required": ["facts"],
        "additionalProperties": false
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InitError {
    /// The send was aborted (only the timeout can do that here).
    Aborted,
    /// Provider or parse failure, already a plain message.
    Other(String),
}

/// The single LLM send memory initialisation needs. [`Llm`] implements it;
/// tests substitute canned senders.
pub trait InitSender {
    /// `<provider> / <model|(default)>`, for error messages.
    fn label(&self) -> String;
    fn send_facts(
        &self,
        system: &str,
        user: &str,
    ) -> impl Future<Output = Result<Vec<String>, InitError>>;
}

impl InitSender for Llm {
    fn label(&self) -> String {
        Llm::label(self).to_string()
    }

    /// One send: the probe dump is the only user message, and the facts come
    /// back through the typed result with the send's default parse retry.
    fn send_facts(
        &self,
        system: &str,
        user: &str,
    ) -> impl Future<Output = Result<Vec<String>, InitError>> {
        let mut chat = self.start_conversation(ConversationOptions {
            system: system.to_string(),
            format_echo: None,
        });
        chat.add(
            LlmMessage {
                role: Role::User,
                content: user.to_string(),
            },
            false,
        );
        async move {
            match chat
                .send::<InitFacts>(&init_facts_schema(), SendOptions::default())
                .await
            {
                Ok(parsed) => Ok(parsed.facts),
                Err(LlmError::Aborted) => Err(InitError::Aborted),
                Err(e) => Err(InitError::Other(e.to_string())),
            }
        }
    }
}

/// Where `ensure_memory` narrates progress.
pub trait InitUi {
    fn chrome(&self, text: &str, icon: &str);
    fn verbose(&self, line: &str);
}

/// [`InitUi`] over Wrap's stderr chrome.
pub struct ChromeInitUi {
    pub verbose: bool,
}

impl InitUi for ChromeInitUi {
    fn chrome(&self, text: &str, icon: &str) {
        crate::chrome::chrome(text, Some(icon));
    }
    fn verbose(&self, line: &str) {
        crate::chrome::verbose(self.verbose, line);
    }
}

/// Existing memory, or first-run initialisation: probe the system, ask the
/// model for facts in one send, persist them under `/`. Errors are complete
/// user-facing messages in Wrap's voice.
pub async fn ensure_memory(
    home: &WrapHome,
    sender: &impl InitSender,
    ui: &impl InitUi,
) -> Result<Memory, String> {
    ensure_memory_with_timeout(home, sender, ui, INIT_SEND_TIMEOUT).await
}

pub async fn ensure_memory_with_timeout(
    home: &WrapHome,
    sender: &impl InitSender,
    ui: &impl InitUi,
    timeout: Duration,
) -> Result<Memory, String> {
    let existing = load_memory(home)?;
    if !existing.is_empty() {
        let total = count_facts(&existing);
        let global = existing.get("/").map_or(0, Vec::len);
        ui.verbose(&format!(
            "Memory: {total} facts ({global} global, {} scoped)",
            total - global
        ));
        return Ok(existing);
    }

    ui.chrome("Learning about your system...", "✨");
    ui.verbose("Init: probing OS and shell...");
    let probe_output = run_probes();
    ui.verbose("Init: calling LLM to extract system facts...");

    let outcome = tokio::time::timeout(
        timeout,
        sender.send_facts(INIT_SYSTEM_PROMPT, &probe_output),
    )
    .await
    .unwrap_or(Err(InitError::Aborted));
    let facts = match outcome {
        Ok(facts) => facts,
        Err(InitError::Aborted) => {
            return Err(format!(
                "LLM error ({}): no response after {} seconds — check your internet connection and try again.",
                sender.label(),
                timeout.as_secs()
            ));
        }
        Err(InitError::Other(message)) => {
            return Err(format!("LLM error ({}): {message}", sender.label()));
        }
    };

    // Sloppy model output must not persist empty or untrimmed facts forever.
    let facts: Vec<Fact> = facts
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(|fact| Fact { fact })
        .collect();
    ui.verbose(&format!("Init: {} facts extracted", facts.len()));
    let memory: Memory = BTreeMap::from([("/".to_string(), facts)]);
    save_memory(home, &memory)
        .map_err(|e| format!("Memory error: could not save memory — {}.", io_reason(&e)))?;
    ui.chrome("Detected OS and shell", "🧠");
    Ok(memory)
}
