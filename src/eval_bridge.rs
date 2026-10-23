//! The eval bridge behind the hidden `--eval-bridge` flag: the prompt
//! optimizer (`eval/dspy/optimize.py`) runs it as a subprocess with one JSON
//! request on stdin and reads one JSON line from stdout.
//!
//! `assemble` returns the request a real send would carry; `execute` sends
//! it once (no corrective retry, since malformed output is the optimization
//! signal) and reports the parsed response or a classified failure. The
//! stdout shapes are a cross-language contract with the Python side.

use crate::cli::Modifiers;
use crate::config::{apply_model_override, load_config, resolve_provider, resolve_settings};
use crate::home::WrapHome;
use crate::llm::{
    ConversationOptions, Llm, LlmConfig, LlmError, LlmMessage, Role, SendOptions, TestResponses,
    init_llm,
};
use crate::logging::Turn;
use crate::prompt::{
    FewShotExample, Memory, PromptConfig, QueryContext, RequestFraming, TurnFramer,
    build_prompt_scaffold, constants, format_context,
};
use crate::response::{CommandResponse, command_response_json_schema};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Read;

/// The hidden CLI flag that selects the bridge. Absent from help and completion.
pub const FLAG: &str = "--eval-bridge";

/// What one bridge invocation produces: the process exit code, the stdout
/// payload (one JSON line, newline-terminated, empty on fatal errors) and
/// any diagnostics for stderr.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    fn fatal(message: impl Into<String>) -> Self {
        let mut stderr = message.into();
        stderr.push('\n');
        Outcome {
            exit_code: 1,
            stdout: String::new(),
            stderr,
        }
    }

    fn json(value: Value) -> Self {
        Outcome {
            exit_code: 0,
            stdout: format!("{value}\n"),
            stderr: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Assemble,
    Execute,
}

/// The request schema. Unknown top-level fields are rejected so a stale
/// caller cannot silently degrade the eval signal.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeInput {
    mode: Mode,
    instruction: String,
    few_shot_examples: Vec<FewShotExample>,
    schema_text: String,
    memory: Memory,
    cwd: String,
    piped: bool,
    query: String,
    #[serde(default)]
    extra_messages: Option<Vec<LlmMessage>>,
    #[serde(default)]
    last_round: Option<bool>,
    #[serde(default)]
    attached_input_path: Option<String>,
    #[serde(default)]
    attached_input_size: Option<u64>,
    #[serde(default)]
    attached_input_preview: Option<String>,
    #[serde(default)]
    attached_input_truncated: Option<bool>,
}

/// Run the bridge on an already-read stdin payload.
pub async fn execute(stdin_json: &str, home: &WrapHome, env: &HashMap<String, String>) -> Outcome {
    let input: BridgeInput = match serde_json::from_str(stdin_json) {
        Ok(input) => input,
        Err(error) => return Outcome::fatal(format!("Eval bridge error: {error}")),
    };
    let (system, messages) = match assemble_messages(&input) {
        Ok(assembled) => assembled,
        Err(message) => return Outcome::fatal(message),
    };
    match input.mode {
        Mode::Assemble => match assemble_request(system, messages, env).await {
            Ok((system, messages)) => Outcome::json(json!({
                "ok": true,
                "promptInput": { "system": system, "messages": messages },
            })),
            Err(message) => Outcome::fatal(message),
        },
        Mode::Execute => {
            let llm = match build_llm(home, env) {
                Ok(llm) => llm,
                Err(message) => return Outcome::fatal(message),
            };
            Outcome::json(execute_once(&llm, system, messages).await)
        }
    }
}

/// [`execute`], with diagnostics written to stderr. Returns the exit code
/// and the stdout payload.
pub async fn run(
    stdin_json: &str,
    home: &WrapHome,
    env: &HashMap<String, String>,
) -> (i32, String) {
    let outcome = execute(stdin_json, home, env).await;
    if !outcome.stderr.is_empty() {
        eprint!("{}", outcome.stderr);
    }
    (outcome.exit_code, outcome.stdout)
}

/// The full subprocess entry: read stdin to the end, run, write the stdout
/// payload. Returns the exit code for the caller to exit with.
pub async fn run_from_stdin(home: &WrapHome, env: &HashMap<String, String>) -> i32 {
    let mut stdin_json = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut stdin_json) {
        eprintln!("Eval bridge error: could not read stdin ({error}).");
        return 1;
    }
    let (exit_code, stdout) = run(&stdin_json, home, env).await;
    if !stdout.is_empty() {
        print!("{stdout}");
    }
    exit_code
}

/// Build the system text and the message list the runtime would send:
/// few-shot prefix, prior turns (`extraMessages`) framed in order, the
/// current query as the first real user turn, then the last-round notice.
fn assemble_messages(input: &BridgeInput) -> Result<(String, Vec<LlmMessage>), String> {
    let c = constants();
    let ctx = QueryContext {
        cwd: input.cwd.clone(),
        memory: input.memory.clone(),
        piped: input.piped,
        attached_input_path: input.attached_input_path.clone(),
        attached_input_size: input.attached_input_size,
        attached_input_preview: input.attached_input_preview.clone(),
        attached_input_truncated: input.attached_input_truncated.unwrap_or(false),
    };
    let context_string = format_context(&ctx);
    let scaffold = build_prompt_scaffold(
        &PromptConfig {
            instruction: input.instruction.clone(),
            schema_instruction: c.schema_instruction.clone(),
            schema_text: input.schema_text.clone(),
            memory_recency_instruction: c.memory_recency_instruction.clone(),
            tools_scope_instruction: c.tools_scope_instruction.clone(),
            voice_instructions: c.voice_instructions.clone(),
            temp_dir_principle: c.temp_dir_principle.clone(),
            final_flag_instruction: c.final_flag_instruction.clone(),
            wrap_note_instruction: c.wrap_note_instruction.clone(),
            attached_input_instruction: input
                .attached_input_preview
                .as_ref()
                .map(|_| c.attached_input_instruction.clone()),
            few_shot_examples: input.few_shot_examples.clone(),
            few_shot_separator: c.few_shot_separator.clone(),
            section_user_request: c.section_user_request.clone(),
        },
        &context_string,
    );

    let mut framer = TurnFramer::new(Some(RequestFraming {
        context_string,
        section_user_request: c.section_user_request.clone(),
    }));
    let mut messages = scaffold.prefix_messages;

    // A user message that starts with the captured-output header is a step
    // turn, so the request framing skips it and lands on the real query.
    let step_prefix = format!("{}\n", c.section_captured_output);
    for message in input.extra_messages.iter().flatten() {
        match message.role {
            Role::User => {
                let turn = match message.content.strip_prefix(step_prefix.as_str()) {
                    Some(output) => Turn::Step {
                        command: String::new(),
                        exit_code: 0,
                        output: output.to_string(),
                        shell: String::new(),
                        source: "model".into(),
                        exec_ms: None,
                    },
                    None => Turn::User {
                        text: message.content.clone(),
                    },
                };
                messages.extend(framer.frame(&turn));
            }
            Role::Assistant => messages.push(assistant_message(&message.content, &mut framer)?),
        }
    }
    messages.extend(framer.frame(&Turn::User {
        text: input.query.clone(),
    }));
    if input.last_round == Some(true) {
        messages.push(LlmMessage {
            role: Role::User,
            content: c.last_round_instruction.clone(),
        });
    }
    Ok((scaffold.system, messages))
}

/// An assistant turn arrives as raw command-response JSON and is echoed the
/// way the runtime echoes it: a schema-valid response through the framer's
/// projection; anything else keeps only the projected keys it carries.
fn assistant_message(content: &str, framer: &mut TurnFramer) -> Result<LlmMessage, String> {
    let value: Value = serde_json::from_str(content).map_err(|_| {
        "Eval bridge error: an assistant entry in extraMessages is not valid JSON.".to_string()
    })?;
    if let Ok(response) = serde_json::from_value::<CommandResponse>(value.clone()) {
        let turn = Turn::Assistant {
            response: Some(response),
            attempts: Vec::new(),
            llm_ms: None,
            source: "model".into(),
        };
        if let Some(message) = framer.frame(&turn).into_iter().next() {
            return Ok(message);
        }
    }
    let mut projected = Map::new();
    if let Some(object) = value.as_object() {
        for key in ["type", "final", "content", "risk_level", "plan"] {
            if let Some(field) = object.get(key) {
                projected.insert(key.to_string(), field.clone());
            }
        }
    }
    Ok(LlmMessage {
        role: Role::Assistant,
        content: Value::Object(projected).to_string(),
    })
}

/// Recover the assembled request through the conversation's own machinery:
/// a test-provider conversation whose canned reply never parses, sent once
/// without retry, leaves the request on the sealed entry's attempt.
async fn assemble_request(
    system: String,
    messages: Vec<LlmMessage>,
    env: &HashMap<String, String>,
) -> Result<(String, Vec<LlmMessage>), String> {
    let canned = Value::String("assemble probe (never parses)".into());
    let llm = Llm::new(LlmConfig::Test(TestResponses::Single(canned)), env)
        .map_err(|m| format!("Eval bridge error: {m}"))?;
    let mut chat = llm.start_conversation(ConversationOptions {
        system,
        format_echo: None,
    });
    for message in messages {
        chat.add(message, false);
    }
    match send_once(&mut chat).await {
        Err(LlmError::Parse { .. }) => {}
        Ok(_) => return Err("Eval bridge error: the assemble probe unexpectedly parsed.".into()),
        Err(error) => return Err(format!("Eval bridge error: {error}")),
    }
    let request = chat
        .entries()
        .last()
        .and_then(|entry| entry.attempts.first())
        .map(|attempt| &attempt.request)
        .ok_or_else(|| {
            "Eval bridge error: assemble failed, the conversation recorded no attempt.".to_string()
        })?;
    Ok((request.system.clone(), request.messages.clone()))
}

/// The provider for execute mode: `config.jsonc` under `WRAP_CONFIG`, the
/// `WRAP_MODEL` override, then the resolved provider (or the canned test
/// provider when `WRAP_TEST_RESPONSE(S)` is set).
fn build_llm(home: &WrapHome, env: &HashMap<String, String>) -> Result<Llm, String> {
    let modifiers = Modifiers::default();
    let file = load_config(home, env).map_err(|m| format!("Config error: {m}"))?;
    let resolved =
        resolve_settings(&modifiers, env, &file).map_err(|m| format!("Config error: {m}"))?;
    let resolved = apply_model_override(resolved, &modifiers, env)?;
    let provider = resolve_provider(&resolved, env)?;
    init_llm(provider, env).map_err(|m| format!("Config error: {m}"))
}

async fn send_once(chat: &mut crate::llm::Conversation) -> Result<CommandResponse, LlmError> {
    chat.send::<CommandResponse>(
        command_response_json_schema(),
        SendOptions {
            cancel: None,
            retry: false,
        },
    )
    .await
}

/// One send, classified: the parsed response, or the send's own failure
/// reason with the raw text (parse failures) or message (provider failures).
async fn execute_once(llm: &Llm, system: String, messages: Vec<LlmMessage>) -> Value {
    let mut chat = llm.start_conversation(ConversationOptions {
        system,
        format_echo: None,
    });
    for message in messages {
        chat.add(message, false);
    }
    match send_once(&mut chat).await {
        Ok(response) => json!({ "ok": true, "response": response }),
        Err(LlmError::Parse {
            message,
            raw_text,
            reason,
        }) => json!({
            "ok": false,
            "error": reason,
            "rawText": raw_text,
            "message": message,
        }),
        Err(error) => json!({
            "ok": false,
            "error": "provider_error",
            "message": error.to_string(),
        }),
    }
}
