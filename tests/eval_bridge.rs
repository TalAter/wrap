use serde_json::{Value, json};
use std::collections::HashMap;
use wrap::eval_bridge::{Outcome, execute};
use wrap::home::WrapHome;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn base_input(mode: &str) -> Value {
    json!({
        "mode": mode,
        "instruction": "You are a CLI tool.",
        "fewShotExamples": [],
        "schemaText": "z.object({ type: z.string() })",
        "memory": { "/": [{ "fact": "macOS arm64" }] },
        "cwd": "/home/user",
        "piped": false,
        "query": "list files",
    })
}

fn with(mut input: Value, extra: Value) -> Value {
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    input
}

async fn bridge(input: &Value, pairs: &[(&str, &str)]) -> Outcome {
    let home = tempfile::tempdir().unwrap();
    let home = WrapHome::new(home.path());
    execute(&input.to_string(), &home, &env(pairs)).await
}

async fn result(input: &Value, pairs: &[(&str, &str)]) -> Value {
    let outcome = bridge(input, pairs).await;
    assert_eq!(
        outcome.exit_code,
        0,
        "bridge crashed: {}",
        outcome.stderr.trim()
    );
    assert!(outcome.stdout.ends_with('\n'));
    serde_json::from_str(&outcome.stdout).unwrap()
}

fn messages(result: &Value) -> Vec<Value> {
    result["promptInput"]["messages"]
        .as_array()
        .unwrap()
        .clone()
}

fn content(message: &Value) -> &str {
    message["content"].as_str().unwrap()
}

const TEST_PROVIDER: &[(&str, &str)] = &[("WRAP_CONFIG", "{}")];

const VALID_RESPONSE: &str =
    r#"{"type":"command","content":"ls -la","risk_level":"low","explanation":"List files"}"#;

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

#[tokio::test]
async fn assemble_returns_system_and_messages() {
    let result = result(&base_input("assemble"), &[]).await;
    assert_eq!(result["ok"], json!(true));
    let system = result["promptInput"]["system"].as_str().unwrap();
    assert!(system.contains("You are a CLI tool."));
    assert!(system.contains("z.object({ type: z.string() })"));
    assert!(result["promptInput"]["messages"].is_array());
    assert!(result["promptInput"].get("schema").is_none());
}

#[tokio::test]
async fn first_user_turn_carries_context_and_request_header() {
    let result = result(&base_input("assemble"), &[]).await;
    let msgs = messages(&result);
    let last = msgs.last().unwrap();
    assert_eq!(last["role"], json!("user"));
    assert!(content(last).contains("macOS arm64"));
    assert!(content(last).contains("## User's request\nlist files"));
}

#[tokio::test]
async fn legacy_top_level_fields_are_rejected() {
    let input = with(
        base_input("assemble"),
        json!({
            "tools": { "available": ["/usr/bin/git"], "unavailable": ["docker"] },
            "cwdFiles": "package.json\nsrc/\n",
        }),
    );
    let outcome = bridge(&input, &[]).await;
    assert_ne!(outcome.exit_code, 0);
    assert!(outcome.stdout.is_empty());
    assert!(
        outcome.stderr.contains("tools") || outcome.stderr.contains("cwdFiles"),
        "stderr: {}",
        outcome.stderr
    );
}

#[tokio::test]
async fn invalid_stdin_json_is_fatal() {
    let home = tempfile::tempdir().unwrap();
    let outcome = execute("not json{{{", &WrapHome::new(home.path()), &env(&[])).await;
    assert_ne!(outcome.exit_code, 0);
    assert!(outcome.stdout.is_empty());
    assert!(!outcome.stderr.trim().is_empty());
}

#[tokio::test]
async fn last_round_appends_instruction_as_separate_user_message() {
    let input = with(base_input("assemble"), json!({ "lastRound": true }));
    let msgs = messages(&result(&input, &[]).await);
    let last = &msgs[msgs.len() - 1];
    assert_eq!(last["role"], json!("user"));
    assert!(content(last).contains("terminal response"));
    let request = &msgs[msgs.len() - 2];
    assert!(content(request).contains("list files"));
    assert!(!content(request).contains("terminal response"));
}

#[tokio::test]
async fn extra_messages_precede_the_current_query() {
    let input = with(
        base_input("assemble"),
        json!({
            "extraMessages": [
                { "role": "assistant", "content": "{\"type\":\"probe\",\"content\":\"which sips\"}" },
                { "role": "user", "content": "## Probe output\n/usr/bin/sips" },
            ],
        }),
    );
    let msgs = messages(&result(&input, &[]).await);
    let n = msgs.len();
    assert_eq!(msgs[n - 1]["role"], json!("user"));
    assert!(content(&msgs[n - 1]).contains("list files"));
    assert_eq!(msgs[n - 2]["role"], json!("user"));
    assert!(content(&msgs[n - 2]).contains("Probe output"));
    assert_eq!(msgs[n - 3]["role"], json!("assistant"));
    assert!(content(&msgs[n - 3]).contains("probe"));
}

#[tokio::test]
async fn captured_output_messages_do_not_consume_request_framing() {
    let input = with(
        base_input("assemble"),
        json!({
            "extraMessages": [
                { "role": "assistant", "content": "{\"type\":\"command\",\"final\":false,\"content\":\"which ffmpeg\",\"risk_level\":\"low\"}" },
                { "role": "user", "content": "## Captured output\n/opt/homebrew/bin/ffmpeg" },
            ],
        }),
    );
    let msgs = messages(&result(&input, &[]).await);
    let n = msgs.len();
    assert_eq!(msgs[n - 1]["role"], json!("user"));
    assert!(content(&msgs[n - 1]).contains("## User's request\nlist files"));
    let step = &msgs[n - 2];
    assert_eq!(step["role"], json!("user"));
    assert!(content(step).contains("## Captured output"));
    assert!(content(step).contains("/opt/homebrew/bin/ffmpeg"));
    assert!(!content(step).contains("## User's request"));
    assert!(!content(step).contains("macOS arm64"));
}

#[tokio::test]
async fn assistant_extra_messages_are_projected_for_echo() {
    let input = with(
        base_input("assemble"),
        json!({
            "extraMessages": [
                { "role": "assistant", "content": "{\"type\":\"command\",\"content\":\"which ffmpeg\",\"risk_level\":\"low\",\"explanation\":\"Locate ffmpeg\",\"_scratchpad\":\"thinking\"}" },
                { "role": "user", "content": "## Captured output\n/opt/homebrew/bin/ffmpeg" },
            ],
        }),
    );
    let msgs = messages(&result(&input, &[]).await);
    let assistant = &msgs[msgs.len() - 3];
    assert_eq!(assistant["role"], json!("assistant"));
    let echoed: Value = serde_json::from_str(content(assistant)).unwrap();
    assert_eq!(
        echoed,
        json!({"type":"command","final":true,"content":"which ffmpeg","risk_level":"low"})
    );
}

#[tokio::test]
async fn extra_messages_and_last_round_keep_instruction_last() {
    let input = with(
        base_input("assemble"),
        json!({
            "extraMessages": [
                { "role": "assistant", "content": "{\"type\":\"probe\"}" },
                { "role": "user", "content": "## Probe output\nresult" },
            ],
            "lastRound": true,
        }),
    );
    let msgs = messages(&result(&input, &[]).await);
    let n = msgs.len();
    assert!(content(&msgs[n - 1]).contains("terminal response"));
    assert!(content(&msgs[n - 2]).contains("list files"));
    assert!(content(&msgs[n - 3]).contains("Probe output"));
}

#[tokio::test]
async fn few_shot_examples_become_pairs_with_separator() {
    let input = with(
        base_input("assemble"),
        json!({ "fewShotExamples": [{ "input": "do stuff", "output": "{\"result\":\"done\"}" }] }),
    );
    let msgs = messages(&result(&input, &[]).await);
    assert_eq!(msgs[0], json!({ "role": "user", "content": "do stuff" }));
    assert_eq!(
        msgs[1],
        json!({ "role": "assistant", "content": "{\"result\":\"done\"}" })
    );
    assert_eq!(
        msgs[2],
        json!({ "role": "user", "content": "Now handle the following request." })
    );
    assert!(content(&msgs[3]).contains("list files"));
}

#[tokio::test]
async fn attached_input_reaches_system_and_context() {
    let input = with(
        base_input("assemble"),
        json!({
            "attachedInputPath": "$WRAP_TEMP_DIR/input",
            "attachedInputSize": 12,
            "attachedInputPreview": "hello piped",
            "attachedInputTruncated": false,
        }),
    );
    let result = result(&input, &[]).await;
    let system = result["promptInput"]["system"].as_str().unwrap();
    assert!(
        system.contains("The user's stdin has been saved to a file"),
        "system: {system}"
    );
    let msgs = messages(&result);
    let last = content(msgs.last().unwrap());
    assert!(last.contains("## Attached input"));
    assert!(last.contains("$WRAP_TEMP_DIR/input"));
    assert!(last.contains("hello piped"));
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

#[tokio::test]
async fn execute_returns_validated_response() {
    let mut pairs = TEST_PROVIDER.to_vec();
    pairs.push(("WRAP_TEST_RESPONSE", VALID_RESPONSE));
    let result = result(&base_input("execute"), &pairs).await;
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["response"]["type"], json!("command"));
    assert_eq!(result["response"]["content"], json!("ls -la"));
}

#[tokio::test]
async fn execute_reports_invalid_json_with_raw_text() {
    let mut pairs = TEST_PROVIDER.to_vec();
    pairs.push(("WRAP_TEST_RESPONSE", "Sure! Here is the command..."));
    let result = result(&base_input("execute"), &pairs).await;
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"], json!("invalid_json"));
    assert_eq!(result["rawText"], json!("Sure! Here is the command..."));
    assert!(result["message"].is_string());
}

#[tokio::test]
async fn execute_reports_invalid_schema_with_raw_text() {
    let mut pairs = TEST_PROVIDER.to_vec();
    pairs.push(("WRAP_TEST_RESPONSE", r#"{"type":"unknown","content":"x"}"#));
    let result = result(&base_input("execute"), &pairs).await;
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"], json!("invalid_schema"));
    assert_eq!(
        result["rawText"],
        json!(r#"{"type":"unknown","content":"x"}"#)
    );
}

#[tokio::test]
async fn execute_makes_exactly_one_attempt() {
    let responses = json!(["not json", VALID_RESPONSE]).to_string();
    let mut pairs = TEST_PROVIDER.to_vec();
    pairs.push(("WRAP_TEST_RESPONSES", responses.as_str()));
    let result = result(&base_input("execute"), &pairs).await;
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"], json!("invalid_json"));
}

#[tokio::test]
async fn execute_reports_provider_errors() {
    let mut pairs = TEST_PROVIDER.to_vec();
    pairs.push(("WRAP_TEST_RESPONSE", "ERROR:429 rate limit exceeded"));
    let result = result(&base_input("execute"), &pairs).await;
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"], json!("provider_error"));
    assert!(
        result["message"]
            .as_str()
            .unwrap()
            .contains("rate limit exceeded")
    );
    assert!(result.get("rawText").is_none());
}

#[tokio::test]
async fn execute_without_a_provider_is_a_config_error() {
    let outcome = bridge(&base_input("execute"), TEST_PROVIDER).await;
    assert_ne!(outcome.exit_code, 0);
    assert!(outcome.stdout.is_empty());
    assert!(
        outcome.stderr.starts_with("Config error:"),
        "stderr: {}",
        outcome.stderr
    );
}

#[tokio::test]
async fn execute_honors_wrap_model_override() {
    // A `:model` override with no default provider fails inside override
    // resolution, which proves the env override reached config loading.
    let outcome = bridge(
        &base_input("execute"),
        &[("WRAP_CONFIG", "{}"), ("WRAP_MODEL", ":claude-x")],
    )
    .await;
    assert_ne!(outcome.exit_code, 0);
    assert!(outcome.stdout.is_empty());
    assert!(
        outcome.stderr.contains("--model") && outcome.stderr.contains("claude-x"),
        "stderr: {}",
        outcome.stderr
    );
}
