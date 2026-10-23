//! Prompt content and framing: the embedded prompt assets, the per-session
//! scaffold (system text, few-shot prefix, context block), the context
//! formatter, and the turn framer that turns transcript turns into
//! conversation messages at add time.

use crate::llm::{EchoPredicate, LlmMessage, Role};
use crate::response::CommandResponse;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};

/// Hand-edited static prompt strings (`constants.json`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Constants {
    pub section_system_facts: String,
    pub section_facts_about: String,
    pub section_attached_input: String,
    pub section_user_request: String,
    pub few_shot_separator: String,
    pub schema_instruction: String,
    pub memory_recency_instruction: String,
    pub tools_scope_instruction: String,
    pub voice_instructions: String,
    pub attached_input_instruction: String,
    pub piped_output_instruction: String,
    pub last_round_instruction: String,
    pub scratchpad_required_instruction: String,
    pub wrap_note_instruction: String,
    pub final_flag_instruction: String,
    pub section_captured_output: String,
    pub captured_no_output: String,
    pub section_temp_dir: String,
    pub temp_dir_empty: String,
    pub temp_dir_principle: String,
    pub json_retry_instruction: String,
}

pub fn constants() -> &'static Constants {
    static CONSTANTS: OnceLock<Constants> = OnceLock::new();
    CONSTANTS.get_or_init(|| {
        serde_json::from_str(include_str!("constants.json")).expect("embedded prompt constants")
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct FewShotExample {
    pub input: String,
    pub output: String,
}

/// Optimizer output (`optimized.json`): the instruction, schema text mirror,
/// and few-shot examples.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Optimized {
    pub instruction: String,
    pub few_shot_examples: Vec<FewShotExample>,
    pub schema_text: String,
    pub prompt_hash: String,
}

pub fn optimized() -> &'static Optimized {
    static OPTIMIZED: OnceLock<Optimized> = OnceLock::new();
    OPTIMIZED.get_or_init(|| {
        serde_json::from_str(include_str!("optimized.json")).expect("embedded optimized prompt")
    })
}

/// The schema source the LLM sees, with its guiding comments.
pub const SCHEMA_SOURCE: &str = include_str!("schema.txt");

pub use crate::memory::{Fact, Memory};

pub use crate::logging::{AttemptMeta, LoggedRequest, Turn};

/// Everything the scaffold builder needs, as plain strings.
#[derive(Clone, Debug)]
pub struct PromptConfig {
    pub instruction: String,
    pub schema_instruction: String,
    pub schema_text: String,
    pub memory_recency_instruction: String,
    pub tools_scope_instruction: String,
    pub voice_instructions: String,
    pub temp_dir_principle: String,
    pub final_flag_instruction: String,
    pub wrap_note_instruction: String,
    pub attached_input_instruction: Option<String>,
    pub few_shot_examples: Vec<FewShotExample>,
    pub few_shot_separator: String,
    pub section_user_request: String,
}

/// The static, per-session pieces of the prompt. `context_string` and
/// `section_user_request` feed the framer so the first user turn is wrapped
/// as it is added; storage stays bare.
#[derive(Clone, Debug, PartialEq)]
pub struct PromptScaffold {
    pub system: String,
    pub prefix_messages: Vec<LlmMessage>,
    pub context_string: String,
    pub section_user_request: String,
}

pub fn build_prompt_scaffold(config: &PromptConfig, context_string: &str) -> PromptScaffold {
    let mut parts: Vec<&str> = vec![
        &config.instruction,
        &config.memory_recency_instruction,
        &config.tools_scope_instruction,
        &config.voice_instructions,
        &config.temp_dir_principle,
        &config.final_flag_instruction,
        &config.wrap_note_instruction,
    ];
    if let Some(attached) = &config.attached_input_instruction {
        parts.push(attached);
    }
    let schema_block = format!("{}\n{}", config.schema_instruction, config.schema_text);
    if !config.schema_text.is_empty() {
        parts.push(&schema_block);
    }

    let mut prefix_messages = Vec::new();
    if !config.few_shot_examples.is_empty() {
        for example in &config.few_shot_examples {
            prefix_messages.push(LlmMessage {
                role: Role::User,
                content: example.input.clone(),
            });
            prefix_messages.push(LlmMessage {
                role: Role::Assistant,
                content: example.output.clone(),
            });
        }
        prefix_messages.push(LlmMessage {
            role: Role::User,
            content: config.few_shot_separator.clone(),
        });
    }

    PromptScaffold {
        system: parts.join("\n\n"),
        prefix_messages,
        context_string: context_string.to_string(),
        section_user_request: config.section_user_request.clone(),
    }
}

/// Per-invocation inputs to the context block.
#[derive(Clone, Debug, Default)]
pub struct QueryContext {
    pub cwd: String,
    pub memory: Memory,
    pub piped: bool,
    pub attached_input_path: Option<String>,
    pub attached_input_size: Option<u64>,
    pub attached_input_preview: Option<String>,
    pub attached_input_truncated: bool,
}

/// Assemble the scaffold from the embedded prompt assets and the query
/// context. Called once per session.
pub fn assemble_prompt_scaffold(ctx: &QueryContext) -> PromptScaffold {
    let c = constants();
    let o = optimized();
    let config = PromptConfig {
        instruction: o.instruction.clone(),
        schema_instruction: c.schema_instruction.clone(),
        schema_text: o.schema_text.clone(),
        memory_recency_instruction: c.memory_recency_instruction.clone(),
        tools_scope_instruction: c.tools_scope_instruction.clone(),
        voice_instructions: c.voice_instructions.clone(),
        temp_dir_principle: c.temp_dir_principle.clone(),
        final_flag_instruction: c.final_flag_instruction.clone(),
        wrap_note_instruction: c.wrap_note_instruction.clone(),
        attached_input_instruction: ctx
            .attached_input_preview
            .as_ref()
            .map(|_| c.attached_input_instruction.clone()),
        few_shot_examples: o.few_shot_examples.clone(),
        few_shot_separator: c.few_shot_separator.clone(),
        section_user_request: c.section_user_request.clone(),
    };
    build_prompt_scaffold(&config, &format_context(ctx))
}

use crate::temp::format_size;

/// The knowledge block: attached-input preview, memory facts in scope for
/// `cwd` (global first, then more specific), and the piped-output notice.
/// Probed observations arrive as transcript turns instead.
pub fn format_context(ctx: &QueryContext) -> String {
    let c = constants();
    let mut sections: Vec<String> = Vec::new();

    if let Some(preview) = &ctx.attached_input_preview {
        let mut lines = vec![c.section_attached_input.clone()];
        if let Some(path) = &ctx.attached_input_path {
            let size = ctx
                .attached_input_size
                .map(|s| format!(" ({})", format_size(s)))
                .unwrap_or_default();
            lines.push(format!("Path: {path}{size}"));
        }
        if ctx.attached_input_truncated {
            lines.push(
                "Preview truncated — the file on disk carries the full original bytes.".into(),
            );
        }
        lines.push(String::new());
        lines.push(preview.clone());
        sections.push(lines.join("\n"));
    }

    let cwd_slash = with_trailing_slash(&ctx.cwd);
    for (scope, facts) in &ctx.memory {
        if facts.is_empty() || !cwd_slash.starts_with(&with_trailing_slash(scope)) {
            continue;
        }
        let header = if scope == "/" {
            c.section_system_facts.clone()
        } else {
            format!("{} {scope}", c.section_facts_about)
        };
        let body: Vec<String> = facts.iter().map(|f| format!("- {}", f.fact)).collect();
        sections.push(format!("{header}\n{}", body.join("\n")));
    }

    if ctx.piped {
        sections.push(c.piped_output_instruction.clone());
    }
    sections.join("\n\n")
}

fn with_trailing_slash(path: &str) -> String {
    if path.ends_with('/') {
        path.to_string()
    } else {
        format!("{path}/")
    }
}

/// Framing for the first user turn of an invocation: the context block and
/// the request section header.
#[derive(Clone, Debug, PartialEq)]
pub struct RequestFraming {
    pub context_string: String,
    pub section_user_request: String,
}

/// Stateful turn → message framer bound to one conversation. The first user
/// turn it sees gets the request framing; everything after is framed by turn
/// kind alone.
#[derive(Debug)]
pub struct TurnFramer {
    framing: Option<RequestFraming>,
    first_user_seen: bool,
}

impl TurnFramer {
    pub fn new(framing: Option<RequestFraming>) -> Self {
        Self {
            framing,
            first_user_seen: false,
        }
    }

    pub fn frame(&mut self, turn: &Turn) -> Vec<LlmMessage> {
        match turn {
            Turn::User { text } => {
                let content = match (&self.framing, self.first_user_seen) {
                    (Some(framing), false) => {
                        let mut parts = Vec::new();
                        if !framing.context_string.is_empty() {
                            parts.push(framing.context_string.clone());
                        }
                        parts.push(format!("{}\n{text}", framing.section_user_request));
                        parts.join("\n\n")
                    }
                    _ => text.clone(),
                };
                self.first_user_seen = true;
                vec![LlmMessage {
                    role: Role::User,
                    content,
                }]
            }
            // A fully-failed round is kept in the log but contributes nothing.
            Turn::Assistant { response: None, .. } => vec![],
            Turn::Assistant {
                response: Some(response),
                ..
            } => vec![LlmMessage {
                role: Role::Assistant,
                content: echo_text(response),
            }],
            Turn::Step {
                output, exit_code, ..
            } => vec![LlmMessage {
                role: Role::User,
                content: format_step_body(output, *exit_code),
            }],
            Turn::Probe {
                command, output, ..
            } => vec![
                LlmMessage {
                    role: Role::Assistant,
                    content: json!({
                        "type": "command", "final": false, "content": command, "risk_level": "low"
                    })
                    .to_string(),
                },
                LlmMessage {
                    role: Role::User,
                    content: format_step_body(output, 0),
                },
            ],
            Turn::Final {
                command,
                exit_code,
                source,
                ..
            } => vec![LlmMessage {
                role: Role::User,
                content: format!(
                    "<wrap-note>\n{}\n</wrap-note>",
                    format_final_note(command, *exit_code, source)
                ),
            }],
        }
    }
}

/// Captured output as the model sees it: section header, trimmed body (or
/// the no-output sentinel), trailing exit-code line on non-zero exits.
pub fn format_step_body(output: &str, exit_code: i32) -> String {
    let c = constants();
    let mut body = output.to_string();
    if exit_code != 0 {
        body.push_str(&format!("\nExit code: {exit_code}"));
    }
    let trimmed = body.trim();
    let shown = if trimmed.is_empty() {
        c.captured_no_output.as_str()
    } else {
        trimmed
    };
    format!("{}\n{shown}", c.section_captured_output)
}

fn format_final_note(command: &str, exit_code: Option<i32>, source: &str) -> String {
    let exit = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "null".into());
    match source {
        "model" => format!("previous command exited {exit}"),
        "user_override" => {
            format!("user ran the following instead of the proposal; exited {exit}:\n{command}")
        }
        "cancelled" => format!("user cancelled the previous command: {command}"),
        "blocked" => "previous command was blocked".into(),
        "exhausted" if command.is_empty() => {
            "previous run hit the round budget without completing".into()
        }
        "exhausted" => format!(
            "previous run hit the round budget without completing or executing the proposed command; last proposal was: {command}"
        ),
        _ => "previous run ended in an error before completing".into(),
    }
}

/// The minimal shape echoed back to the model on the next round: `type`,
/// `final`, `content`, `risk_level`, and `plan` when set. User-facing and
/// already-actioned fields are stripped.
pub fn project_response_for_echo(response: &CommandResponse) -> Value {
    let mut out = json!({
        "type": response.kind,
        "final": response.is_final,
        "content": response.content,
        "risk_level": response.risk_level,
    });
    if let Some(plan) = &response.plan {
        out["plan"] = Value::String(plan.clone());
    }
    out
}

/// The canonical assistant-echo text. Every echo site builds its string
/// here so the projection rule is structural.
pub fn echo_text(response: &CommandResponse) -> String {
    project_response_for_echo(response).to_string()
}

/// Domain rejection: a high-risk command must carry a scratchpad.
pub fn is_scratchpad_rejected(response: &CommandResponse) -> bool {
    response.kind == crate::response::ResponseType::Command
        && response.risk_level == crate::response::RiskLevel::High
        && response.scratchpad.is_none()
}

/// The conversation-level echo predicate: a schema-valid response echoes as
/// its projection; a domain-rejected one yields `None` so nothing replayable
/// lands (the round adds the settled echo explicitly).
pub fn format_command_echo() -> EchoPredicate {
    Arc::new(|parsed: &Value, _raw: &str| {
        let response: CommandResponse = serde_json::from_value(parsed.clone()).ok()?;
        if is_scratchpad_rejected(&response) {
            return None;
        }
        Some(echo_text(&response))
    })
}
