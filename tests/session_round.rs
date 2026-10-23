// The bus lock serializes tests that observe the process-global chrome bus;
// each test runs on a single thread, so holding it across awaits is safe.
#![allow(clippy::await_holding_lock)]
mod session_common;

use serde_json::{Value, json};
use session_common::{BusCapture, bus_lock, llm_list, llm_single};
use tokio_util::sync::CancellationToken;
use wrap::llm::{Conversation, ConversationOptions, Llm, LlmMessage, Role, replayable};
use wrap::logging::AttemptErrorKind;
use wrap::prompt::{constants, format_command_echo, project_response_for_echo};
use wrap::response::CommandResponse;
use wrap::session::round::{RoundError, RoundOptions, run_round};

fn chat_over(llm: &Llm) -> Conversation {
    let mut chat = llm.start_conversation(ConversationOptions {
        system: "system".into(),
        format_echo: Some(format_command_echo()),
    });
    chat.add(
        LlmMessage {
            role: Role::User,
            content: "hi".into(),
        },
        false,
    );
    chat
}

fn chat(items: Vec<Value>) -> Conversation {
    chat_over(&llm_list(items))
}

fn options() -> RoundOptions {
    RoundOptions {
        label: "test".into(),
        ..RoundOptions::default()
    }
}

fn physical_calls(chat: &Conversation) -> usize {
    chat.entries().iter().map(|e| e.attempts.len()).sum()
}

/// The messages behind the last physical call of the conversation.
fn last_request(chat: &Conversation) -> Vec<LlmMessage> {
    chat.entries()
        .iter()
        .flat_map(|e| e.attempts.iter())
        .last()
        .map(|a| a.request.messages.clone())
        .unwrap_or_default()
}

fn replayed(chat: &Conversation) -> Vec<LlmMessage> {
    chat.entries()
        .iter()
        .filter(|e| replayable(e))
        .filter_map(|e| e.message.clone())
        .collect()
}

fn echo_of(v: Value) -> String {
    let response: CommandResponse = serde_json::from_value(v).unwrap();
    project_response_for_echo(&response).to_string()
}

fn failed(
    result: Result<impl std::fmt::Debug, RoundError>,
) -> (String, wrap::session::round::AssistantTurn) {
    match result {
        Err(RoundError::Failed { message, turn }) => (message, *turn),
        other => panic!("expected a failed round, got {other:?}"),
    }
}

#[tokio::test]
async fn a_successful_command_round_yields_the_response_and_timing() {
    let mut chat = chat(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    let turn = run_round(&mut chat, options()).await.unwrap();
    let response = turn.response.as_ref().unwrap();
    assert_eq!(response.content, "ls");
    assert!(turn.llm_ms.is_some());
    assert_eq!(turn.attempts.len(), 1);
    assert_eq!(turn.attempts[0].parsed.as_ref().unwrap().content, "ls");
}

#[tokio::test]
async fn a_successful_round_leaves_user_and_projected_echo_replayable() {
    let mut chat = chat(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    run_round(&mut chat, options()).await.unwrap();
    let messages = replayed(&chat);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, "hi");
    assert_eq!(messages[1].role, Role::Assistant);
    assert_eq!(
        messages[1].content,
        echo_of(json!({"type":"command","content":"ls","risk_level":"low","final":true}))
    );
}

#[tokio::test]
async fn the_model_sees_the_temp_dir_listing_every_round_and_the_last_round_instruction_only_on_the_last()
 {
    let mut chat = chat(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    run_round(&mut chat, options()).await.unwrap();
    let users: Vec<_> = last_request(&chat)
        .into_iter()
        .filter(|m| m.role == Role::User)
        .collect();
    assert!(users.iter().any(|m| m.content.contains("$WRAP_TEMP_DIR")));
    assert!(
        !users
            .iter()
            .any(|m| m.content == constants().last_round_instruction)
    );

    let mut chat = chat_over(&llm_list(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]));
    run_round(
        &mut chat,
        RoundOptions {
            is_last_round: true,
            ..options()
        },
    )
    .await
    .unwrap();
    assert!(
        last_request(&chat)
            .iter()
            .any(|m| m.role == Role::User && m.content == constants().last_round_instruction)
    );
}

#[tokio::test]
async fn per_round_transients_do_not_resurrect_next_round() {
    let mut chat = chat(vec![
        json!({"type":"command","final":false,"content":"echo probe","risk_level":"low"}),
        json!({"type":"command","content":"echo done","risk_level":"low"}),
    ]);
    run_round(
        &mut chat,
        RoundOptions {
            is_last_round: true,
            ..options()
        },
    )
    .await
    .unwrap();
    chat.add(
        LlmMessage {
            role: Role::User,
            content: "follow-up".into(),
        },
        false,
    );
    let turn = run_round(&mut chat, options()).await.unwrap();
    let messages = last_request(&chat);
    let temp_sections = messages
        .iter()
        .filter(|m| m.content.starts_with(&constants().section_temp_dir))
        .count();
    assert_eq!(temp_sections, 1);
    assert!(
        !messages
            .iter()
            .any(|m| m.content == constants().last_round_instruction)
    );
    // Round 2 derives only its own send.
    assert_eq!(turn.attempts.len(), 1);
    assert_eq!(
        turn.attempts[0].parsed.as_ref().unwrap().content,
        "echo done"
    );
}

#[tokio::test]
async fn empty_content_fails_the_round_with_an_empty_error_on_the_last_attempt() {
    let mut chat = chat(vec![
        json!({"type":"reply","content":"   ","risk_level":"low"}),
    ]);
    let (message, turn) = failed(run_round(&mut chat, options()).await);
    assert_eq!(message, "LLM returned an empty response.");
    let last = turn.attempts.last().unwrap();
    assert!(last.parsed.is_some());
    assert_eq!(last.error.as_ref().unwrap().kind, AttemptErrorKind::Empty);
    assert!(turn.response.is_some());
}

#[tokio::test]
async fn a_provider_failure_fails_the_round_with_the_label_in_the_message() {
    let mut chat = chat_over(&llm_single("ERROR:network down"));
    let (message, turn) = failed(
        run_round(
            &mut chat,
            RoundOptions {
                label: "test / model".into(),
                ..options()
            },
        )
        .await,
    );
    assert_eq!(message, "LLM error (test / model): network down");
    assert_eq!(turn.attempts.len(), 1);
    let error = turn.attempts[0].error.as_ref().unwrap();
    assert_eq!(error.kind, AttemptErrorKind::Provider);
    assert_eq!(error.message, "network down");
    assert!(turn.response.is_none());
}

#[tokio::test]
async fn an_unparsable_response_is_retried_once_then_fails_with_both_attempts() {
    let mut chat = chat_over(&llm_single("not json at all"));
    let (message, turn) = failed(
        run_round(
            &mut chat,
            RoundOptions {
                label: "test / model".into(),
                ..options()
            },
        )
        .await,
    );
    assert!(message.starts_with("LLM error (test / model): "));
    assert_eq!(turn.attempts.len(), 2);
    for attempt in &turn.attempts {
        assert_eq!(
            attempt.error.as_ref().unwrap().kind,
            AttemptErrorKind::Parse
        );
        assert_eq!(attempt.raw_response.as_deref(), Some("not json at all"));
        assert!(
            attempt.request.is_none(),
            "raw_response alone is the breadcrumb"
        );
    }
}

#[tokio::test]
async fn a_parse_retry_that_recovers_merges_both_attempts_into_one_turn() {
    let mut chat = chat(vec![
        json!("not json"),
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    let turn = run_round(&mut chat, options()).await.unwrap();
    assert_eq!(turn.attempts.len(), 2);
    assert_eq!(
        turn.attempts[0].error.as_ref().unwrap().kind,
        AttemptErrorKind::Parse
    );
    assert!(turn.attempts[0].parsed.is_none());
    assert_eq!(turn.attempts[1].parsed.as_ref().unwrap().content, "ls");
    let summed: u64 = turn.attempts.iter().filter_map(|a| a.llm_ms).sum();
    assert_eq!(turn.llm_ms, Some(summed));
}

#[tokio::test]
async fn a_pre_cancelled_token_aborts_before_any_transient_is_added() {
    let mut chat = chat(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    let before = chat.entries().len();
    let token = CancellationToken::new();
    token.cancel();
    let result = run_round(
        &mut chat,
        RoundOptions {
            cancel: Some(token),
            ..options()
        },
    )
    .await;
    assert!(matches!(result, Err(RoundError::Aborted)));
    assert_eq!(chat.entries().len(), before);
}

// ── verbose ──────────────────────────────────────────────────────

#[tokio::test]
async fn verbose_prints_the_scratchpad_line_before_the_response_line() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let mut chat = chat(vec![json!({
        "_scratchpad": "Need to plan first.\nSecond thought.",
        "type":"command","content":"ls","risk_level":"low"
    })]);
    run_round(
        &mut chat,
        RoundOptions {
            verbose: true,
            ..options()
        },
    )
    .await
    .unwrap();
    let text = capture.text();
    assert!(text.contains("LLM scratchpad: "), "{text}");
    assert!(
        text.contains("Need to plan first. \\n Second thought."),
        "{text}"
    );
    let scratch = text.find("LLM scratchpad").unwrap();
    let responded = text.find("LLM responded (command, low): ").unwrap();
    assert!(responded > scratch);
    assert!(text.contains("ls"));
}

#[tokio::test]
async fn verbose_describes_steps_and_replies_without_a_scratchpad_line() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let mut chat = chat(vec![
        json!({"type":"command","final":false,"content":"echo probe","risk_level":"medium"}),
        json!({"type":"reply","content":"hello","risk_level":"low"}),
    ]);
    let verbose = RoundOptions {
        verbose: true,
        ..options()
    };
    run_round(&mut chat, verbose.clone()).await.unwrap();
    run_round(&mut chat, verbose).await.unwrap();
    let text = capture.text();
    assert!(text.contains("LLM responded (step, medium): "), "{text}");
    assert!(text.contains("LLM responded (reply, 5 chars)"), "{text}");
    assert!(!text.contains("scratchpad"), "{text}");
}

#[tokio::test]
async fn verbose_reports_the_bare_error_before_the_round_fails() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let mut chat = chat_over(&llm_single("ERROR:rate limited"));
    let _ = run_round(
        &mut chat,
        RoundOptions {
            verbose: true,
            ..options()
        },
    )
    .await;
    assert!(capture.text().contains("LLM error: rate limited"));
}

// ── scratchpad domain retry ──────────────────────────────────────

fn rejected() -> Value {
    json!({"_scratchpad": null, "type":"command","content":"echo rm-rf-node-modules-fake","risk_level":"high"})
}

fn filled() -> Value {
    json!({"_scratchpad": "Destructive: blow away deps for a clean install.", "type":"command","content":"echo rm-rf-node-modules-fake","risk_level":"high"})
}

#[tokio::test]
async fn a_high_risk_null_scratchpad_is_retried_once_with_the_raw_rejected_echo() {
    let mut chat = chat(vec![rejected(), filled()]);
    let turn = run_round(&mut chat, options()).await.unwrap();
    assert_eq!(physical_calls(&chat), 2);
    assert_eq!(turn.attempts.len(), 2);
    assert!(
        turn.attempts[0]
            .parsed
            .as_ref()
            .unwrap()
            .scratchpad
            .is_none()
    );
    assert_eq!(
        turn.attempts[1]
            .parsed
            .as_ref()
            .unwrap()
            .scratchpad
            .as_deref(),
        Some("Destructive: blow away deps for a clean install.")
    );
    let messages = last_request(&chat);
    let last = messages.last().unwrap();
    assert_eq!(last.role, Role::User);
    assert_eq!(last.content, constants().scratchpad_required_instruction);
    let echo = &messages[messages.len() - 2];
    assert_eq!(echo.role, Role::Assistant);
    assert!(
        echo.content.contains("\"_scratchpad\":null"),
        "{}",
        echo.content
    );
}

#[tokio::test]
async fn the_filled_retry_echoes_through_the_predicate_with_the_scratchpad_stripped() {
    let mut chat = chat(vec![rejected(), filled()]);
    run_round(&mut chat, options()).await.unwrap();
    let last = replayed(&chat).pop().unwrap();
    assert_eq!(last.role, Role::Assistant);
    let mut expected = filled();
    expected["final"] = json!(true);
    assert_eq!(last.content, echo_of(expected));
    assert!(!last.content.contains("_scratchpad"));
}

#[tokio::test]
async fn no_retry_when_the_scratchpad_is_present_or_the_risk_is_not_high() {
    let mut chat = chat(vec![filled()]);
    run_round(&mut chat, options()).await.unwrap();
    assert_eq!(physical_calls(&chat), 1);

    let mut chat = chat_over(&llm_list(vec![
        json!({"_scratchpad": null, "type":"command","content":"mkdir build","risk_level":"medium"}),
    ]));
    run_round(&mut chat, options()).await.unwrap();
    assert_eq!(physical_calls(&chat), 1);
}

#[tokio::test]
async fn a_still_null_scratchpad_is_accepted_after_one_retry_and_settled_explicitly() {
    let mut chat = chat(vec![rejected(), rejected()]);
    let turn = run_round(&mut chat, options()).await.unwrap();
    assert_eq!(physical_calls(&chat), 2);
    assert_eq!(
        turn.response.as_ref().unwrap().content,
        "echo rm-rf-node-modules-fake"
    );
    let last = replayed(&chat).pop().unwrap();
    let mut expected = rejected();
    expected["final"] = json!(true);
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.content, echo_of(expected));
}

#[tokio::test]
async fn a_scratchpad_retry_that_fails_to_parse_keeps_response_one() {
    let mut chat = chat(vec![rejected(), json!("not json"), json!("still not json")]);
    let turn = run_round(&mut chat, options()).await.unwrap();
    assert_eq!(physical_calls(&chat), 3);
    assert_eq!(turn.attempts.len(), 3);
    assert_eq!(
        turn.response.as_ref().unwrap().content,
        "echo rm-rf-node-modules-fake"
    );
    assert_eq!(
        turn.attempts.last().unwrap().error.as_ref().unwrap().kind,
        AttemptErrorKind::Parse
    );
    let last = replayed(&chat).pop().unwrap();
    let mut expected = rejected();
    expected["final"] = json!(true);
    assert_eq!(last.content, echo_of(expected));
}

#[tokio::test]
async fn a_provider_failure_during_the_scratchpad_retry_fails_the_round_keeping_response_one() {
    let mut chat = chat(vec![rejected(), json!("ERROR:rate limited")]);
    let (message, turn) = failed(
        run_round(
            &mut chat,
            RoundOptions {
                label: "test / model".into(),
                ..options()
            },
        )
        .await,
    );
    assert_eq!(message, "LLM error (test / model): rate limited");
    assert_eq!(turn.attempts.len(), 2);
    assert_eq!(
        turn.response.as_ref().unwrap().content,
        "echo rm-rf-node-modules-fake"
    );
}

#[tokio::test]
async fn scratchpad_retry_transients_do_not_replay_next_round() {
    let mut chat = chat(vec![
        rejected(),
        filled(),
        json!({"type":"command","content":"echo done","risk_level":"low"}),
    ]);
    run_round(&mut chat, options()).await.unwrap();
    chat.add(
        LlmMessage {
            role: Role::User,
            content: "follow-up".into(),
        },
        false,
    );
    run_round(&mut chat, options()).await.unwrap();
    let messages = last_request(&chat);
    assert!(
        !messages
            .iter()
            .any(|m| m.content.contains("\"_scratchpad\":null"))
    );
    assert!(
        !messages
            .iter()
            .any(|m| m.content == constants().scratchpad_required_instruction)
    );
}

// ── trace gating ─────────────────────────────────────────────────

#[tokio::test]
async fn attempts_carry_no_request_or_wire_fields_by_default() {
    let mut chat = chat(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    let turn = run_round(&mut chat, options()).await.unwrap();
    let attempt = &turn.attempts[0];
    assert!(attempt.request.is_none());
    assert!(attempt.request_wire.is_none());
    assert!(attempt.response_wire.is_none());
    assert!(attempt.raw_response.is_none());
}

#[tokio::test]
async fn log_traces_adds_request_wires_and_raw_response() {
    let mut chat = chat(vec![
        json!({"type":"command","content":"ls","risk_level":"low"}),
    ]);
    let turn = run_round(
        &mut chat,
        RoundOptions {
            log_traces: true,
            ..options()
        },
    )
    .await
    .unwrap();
    let attempt = &turn.attempts[0];
    let request = attempt.request.as_ref().unwrap();
    assert_eq!(request.system, "system");
    assert!(request.messages.iter().any(|m| m.content == "hi"));
    assert_eq!(
        serde_json::to_value(attempt.request_wire.as_ref().unwrap()).unwrap()["kind"],
        "test"
    );
    assert_eq!(
        serde_json::to_value(attempt.response_wire.as_ref().unwrap()).unwrap()["kind"],
        "test"
    );
    assert!(attempt.raw_response.as_ref().unwrap().contains("\"ls\""));
}
