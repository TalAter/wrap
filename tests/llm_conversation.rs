use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use wrap::llm::{
    AttemptErrorKind, Conversation, ConversationOptions, Llm, LlmConfig, LlmError, LlmMessage,
    ParseReason, Role, SendOptions, TestResponses, WireRequest, WireResponse, replayable,
};

#[derive(Debug, Deserialize, PartialEq)]
struct Answer {
    answer: String,
}

const JSON_RETRY_INSTRUCTION: &str = "Respond ONLY with valid JSON matching the schema. No markdown fences, no comments, no text outside the JSON object.";

fn schema() -> Value {
    json!({"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false})
}
fn user(s: &str) -> LlmMessage {
    LlmMessage {
        role: Role::User,
        content: s.into(),
    }
}
fn assistant(s: &str) -> LlmMessage {
    LlmMessage {
        role: Role::Assistant,
        content: s.into(),
    }
}
fn llm(responses: TestResponses) -> Llm {
    Llm::new(LlmConfig::Test(responses), &Default::default()).unwrap()
}
fn single(s: &str) -> Llm {
    llm(TestResponses::Single(Value::String(s.into())))
}
fn list(items: &[Value]) -> Llm {
    llm(TestResponses::List(items.to_vec()))
}
fn conv(llm: &Llm) -> Conversation {
    let mut c = llm.start_conversation(ConversationOptions {
        system: "sys".into(),
        format_echo: None,
    });
    c.add(user("q"), false);
    c
}
async fn send(c: &mut Conversation) -> Result<Answer, LlmError> {
    c.send::<Answer>(&schema(), SendOptions::default()).await
}
async fn send_once(c: &mut Conversation) -> Result<Answer, LlmError> {
    c.send::<Answer>(
        &schema(),
        SendOptions {
            cancel: None,
            retry: false,
        },
    )
    .await
}

#[tokio::test]
async fn happy_path_records_echo_parsed_and_one_attempt() {
    let mut c = conv(&single(r#"{"answer":"hi"}"#));
    let out = send(&mut c).await.unwrap();
    assert_eq!(out.answer, "hi");
    assert_eq!(c.entries().len(), 2);
    let entry = &c.entries()[1];
    assert_eq!(entry.message, Some(assistant(r#"{"answer":"hi"}"#)));
    assert_eq!(entry.parsed, Some(json!({"answer":"hi"})));
    assert_eq!(entry.attempts.len(), 1);
    let attempt = &entry.attempts[0];
    assert_eq!(attempt.raw_text.as_deref(), Some(r#"{"answer":"hi"}"#));
    assert!(attempt.error.is_none());
    assert_eq!(attempt.request_wire, Some(WireRequest::Test));
    assert_eq!(attempt.response_wire, Some(WireResponse::Test));
    assert_eq!(attempt.request.system, "sys");
    assert_eq!(attempt.request.messages, vec![user("q")]);
    assert_eq!(attempt.request.schema, Some(schema()));
    assert!(replayable(entry));
}

#[tokio::test]
async fn a_single_fenced_block_parses_while_echo_and_raw_text_stay_verbatim() {
    let fenced = "```json\n{\"answer\":\"hi\"}\n```";
    let mut c = conv(&single(fenced));
    assert_eq!(send(&mut c).await.unwrap().answer, "hi");
    assert_eq!(c.entries()[1].message.as_ref().unwrap().content, fenced);
    assert_eq!(c.entries()[1].attempts[0].raw_text.as_deref(), Some(fenced));
}

#[tokio::test]
async fn fence_stripping_negatives_stay_verbatim_and_classify_as_invalid_json() {
    for raw in [
        "```json\n{\"answer\":\"a\"}\n```\n```json\n{\"answer\":\"b\"}\n```",
        "Here you go:\n```json\n{\"answer\":\"hi\"}\n```\nHope that helps!",
        "```json\n{\"answer\":\"```\"}\n```",
    ] {
        let mut c = conv(&single(raw));
        match send_once(&mut c).await {
            Err(LlmError::Parse {
                raw_text, reason, ..
            }) => {
                assert_eq!(raw_text, raw);
                assert_eq!(reason, ParseReason::InvalidJson);
            }
            other => panic!("expected parse error, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn assembly_follows_add_order_and_keeps_system_out_of_messages() {
    let l = single(r#"{"answer":"ok"}"#);
    let mut c = l.start_conversation(ConversationOptions {
        system: "the system prompt".into(),
        format_echo: None,
    });
    c.add(user("example input"), false);
    c.add(assistant("example output"), false);
    c.add(user("real input"), false);
    send(&mut c).await.unwrap();
    let request = &c.entries()[3].attempts[0].request;
    assert_eq!(request.system, "the system prompt");
    assert_eq!(
        request.messages,
        vec![
            user("example input"),
            assistant("example output"),
            user("real input")
        ]
    );
}

#[tokio::test]
async fn custom_echo_predicate_shapes_the_assistant_message() {
    let l = single(r#"{"answer":"hi"}"#);
    let mut c = l.start_conversation(ConversationOptions {
        system: "sys".into(),
        format_echo: Some(Arc::new(|parsed, raw| {
            assert_eq!(raw, r#"{"answer":"hi"}"#);
            Some(format!("settled: {}", parsed["answer"].as_str().unwrap()))
        })),
    });
    c.add(user("q"), false);
    send(&mut c).await.unwrap();
    assert_eq!(c.entries()[1].message, Some(assistant("settled: hi")));
}

#[tokio::test]
async fn rejected_echo_keeps_forensics_but_never_replays() {
    let l = list(&[
        json!(r#"{"answer":"rejected"}"#),
        json!(r#"{"answer":"ok"}"#),
    ]);
    let mut c = l.start_conversation(ConversationOptions {
        system: "sys".into(),
        format_echo: Some(Arc::new(|parsed, _| {
            (parsed["answer"] != "rejected").then(|| "fine".to_string())
        })),
    });
    c.add(user("q"), false);
    assert_eq!(send(&mut c).await.unwrap().answer, "rejected");
    assert_eq!(c.entries()[1].message, None);
    assert_eq!(c.entries()[1].parsed, Some(json!({"answer":"rejected"})));
    assert_eq!(c.entries()[1].attempts.len(), 1);
    assert!(!replayable(&c.entries()[1]));

    c.add(user("follow-up"), false);
    send(&mut c).await.unwrap();
    let contents: Vec<&str> = c.entries()[3].attempts[0]
        .request
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect();
    assert_eq!(contents, ["q", "follow-up"]);
}

#[tokio::test]
async fn parse_failure_retries_exactly_once_with_the_echo_pair_and_consumes_transients_once() {
    let l = list(&[
        json!("not json"),
        json!(r#"{"answer":"ok"}"#),
        json!(r#"{"answer":"third"}"#),
    ]);
    let mut c = conv(&l);
    c.add(user("live context"), true);
    assert_eq!(send(&mut c).await.unwrap().answer, "ok");

    assert_eq!(c.entries().len(), 3);
    let entry = &c.entries()[2];
    assert_eq!(
        entry.message.as_ref().unwrap().content,
        r#"{"answer":"ok"}"#
    );
    assert_eq!(entry.attempts.len(), 2);
    let first = entry.attempts[0].error.as_ref().unwrap();
    assert_eq!(first.kind, AttemptErrorKind::Parse);
    assert!(first.message.contains("JSON"));
    assert_eq!(entry.attempts[0].raw_text.as_deref(), Some("not json"));
    assert!(entry.attempts[1].error.is_none());
    assert_eq!(
        entry.attempts[1].request.messages,
        vec![
            user("q"),
            user("live context"),
            assistant("not json"),
            user(JSON_RETRY_INSTRUCTION),
        ]
    );
    assert!(
        c.entries()
            .iter()
            .filter_map(|e| e.message.as_ref())
            .all(|m| m.content != JSON_RETRY_INSTRUCTION)
    );
    assert!(c.entries()[1].transient && c.entries()[1].consumed);
    assert!(!replayable(&c.entries()[1]));

    c.add(user("next"), false);
    assert_eq!(send(&mut c).await.unwrap().answer, "third");
    let contents: Vec<&str> = c.entries()[4].attempts[0]
        .request
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect();
    assert_eq!(contents, ["q", r#"{"answer":"ok"}"#, "next"]);
}

#[tokio::test]
async fn schema_mismatch_classifies_as_parse_and_retries() {
    let mut c = conv(&list(&[
        json!(r#"{"wrong":1}"#),
        json!(r#"{"answer":"ok"}"#),
    ]));
    assert_eq!(send(&mut c).await.unwrap().answer, "ok");
    let err = c.entries()[1].attempts[0].error.as_ref().unwrap();
    assert_eq!(err.kind, AttemptErrorKind::Parse);
    assert!(err.message.contains("schema"));
}

#[tokio::test]
async fn second_parse_failure_is_typed_with_raw_text_and_seals_the_entry() {
    let mut c = conv(&list(&[json!("bad one"), json!("bad two")]));
    match send(&mut c).await {
        Err(LlmError::Parse { raw_text, .. }) => assert_eq!(raw_text, "bad two"),
        other => panic!("{other:?}"),
    }
    let entry = &c.entries()[1];
    assert_eq!(entry.message, None);
    assert_eq!(entry.parsed, None);
    let kinds: Vec<AttemptErrorKind> = entry
        .attempts
        .iter()
        .map(|a| a.error.as_ref().unwrap().kind)
        .collect();
    assert_eq!(kinds, [AttemptErrorKind::Parse, AttemptErrorKind::Parse]);
}

#[tokio::test]
async fn retry_false_makes_a_single_attempt_and_reports_both_reasons() {
    let mut c = conv(&list(&[
        json!("not json"),
        json!(r#"{"wrong":1}"#),
        json!(r#"{"answer":"ok"}"#),
    ]));
    match send_once(&mut c).await {
        Err(LlmError::Parse {
            raw_text, reason, ..
        }) => {
            assert_eq!(raw_text, "not json");
            assert_eq!(reason, ParseReason::InvalidJson);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(c.entries()[1].attempts.len(), 1);
    match send_once(&mut c).await {
        Err(LlmError::Parse { reason, .. }) => assert_eq!(reason, ParseReason::InvalidSchema),
        other => panic!("{other:?}"),
    }
    c.add(user("again"), false);
    assert_eq!(send(&mut c).await.unwrap().answer, "ok");
}

#[tokio::test]
async fn single_test_response_repeats_across_sends_and_attempts() {
    let mut c = conv(&single(r#"{"answer":"same"}"#));
    for _ in 0..3 {
        assert_eq!(send(&mut c).await.unwrap().answer, "same");
    }
    let mut never = conv(&single("never json"));
    assert!(matches!(
        send(&mut never).await,
        Err(LlmError::Parse { .. })
    ));
    let raws: Vec<&str> = never.entries()[1]
        .attempts
        .iter()
        .map(|a| a.raw_text.as_deref().unwrap())
        .collect();
    assert_eq!(raws, ["never json", "never json"]);
}

#[tokio::test]
async fn object_test_responses_are_stringified() {
    let mut c = conv(&list(&[json!({"answer":"obj"})]));
    assert_eq!(send(&mut c).await.unwrap().answer, "obj");
    assert_eq!(
        c.entries()[1].attempts[0].raw_text.as_deref(),
        Some(r#"{"answer":"obj"}"#)
    );
}

#[tokio::test]
async fn error_prefixed_test_responses_throw_a_provider_error_and_seal() {
    let mut c = conv(&single("ERROR: boom"));
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => assert_eq!(message, "boom"),
        other => panic!("{other:?}"),
    }
    let entry = &c.entries()[1];
    assert_eq!(entry.message, None);
    assert_eq!(entry.attempts.len(), 1);
    let err = entry.attempts[0].error.as_ref().unwrap();
    assert_eq!(err.kind, AttemptErrorKind::Provider);
    assert_eq!(err.message, "boom");
    assert_eq!(entry.attempts[0].request_wire, Some(WireRequest::Test));
}

#[tokio::test]
async fn an_exhausted_list_fails_the_next_physical_call() {
    let mut c = conv(&list(&[json!(r#"{"answer":"only"}"#)]));
    send(&mut c).await.unwrap();
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => {
            assert_eq!(message, "No test response left for call 2 (1 provided).")
        }
        other => panic!("{other:?}"),
    }

    let mut mid = conv(&list(&[json!("not json")]));
    assert!(matches!(
        send(&mut mid).await,
        Err(LlmError::Provider { .. })
    ));
    let entry = &mid.entries()[1];
    assert_eq!(entry.attempts.len(), 2);
    assert_eq!(
        entry.attempts[0].error.as_ref().unwrap().kind,
        AttemptErrorKind::Parse
    );
    assert_eq!(
        entry.attempts[1].error.as_ref().unwrap().kind,
        AttemptErrorKind::Provider
    );
    assert!(
        entry.attempts[1]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("1 provided")
    );
}

#[tokio::test]
async fn playback_cursor_is_shared_across_conversations_on_one_handle() {
    let l = list(&[
        json!(r#"{"answer":"first"}"#),
        json!(r#"{"answer":"second"}"#),
    ]);
    let mut a = conv(&l);
    let mut b = conv(&l);
    assert_eq!(send(&mut a).await.unwrap().answer, "first");
    assert_eq!(send(&mut b).await.unwrap().answer, "second");
}

#[tokio::test]
async fn an_already_cancelled_token_never_starts_the_send() {
    let mut c = conv(&single(r#"{"answer":"hi"}"#));
    c.add(user("ctx"), true);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = c
        .send::<Answer>(
            &schema(),
            SendOptions {
                cancel: Some(cancel),
                retry: true,
            },
        )
        .await;
    assert!(matches!(result, Err(LlmError::Aborted)));
    assert_eq!(c.entries().len(), 2);
    assert!(!c.entries()[1].consumed);
}

#[tokio::test]
async fn entries_survive_a_json_round_trip() {
    let mut c = conv(&list(&[json!("bad"), json!(r#"{"answer":"ok"}"#)]));
    c.add(user("tmp"), true);
    send(&mut c).await.unwrap();
    let text = serde_json::to_string(c.entries()).unwrap();
    let revived: Vec<wrap::llm::Entry> = serde_json::from_str(&text).unwrap();
    assert_eq!(revived, c.entries());
    let replayed: Vec<&str> = revived
        .iter()
        .filter(|e| replayable(e))
        .map(|e| e.message.as_ref().unwrap().content.as_str())
        .collect();
    assert_eq!(replayed, ["q", r#"{"answer":"ok"}"#]);
}

#[tokio::test]
async fn conversation_can_be_driven_from_a_spawned_task() {
    let l = single(r#"{"answer":"hi"}"#);
    let handle = tokio::spawn(async move {
        let mut c = conv(&l);
        send(&mut c).await.unwrap().answer
    });
    assert_eq!(handle.await.unwrap(), "hi");
}
