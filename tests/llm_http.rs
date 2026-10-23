use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use wrap::llm::{
    AttemptErrorKind, Conversation, ConversationOptions, Llm, LlmConfig, LlmError, LlmMessage,
    ResolvedProvider, Role, SendOptions, WireRequest, WireResponse,
};

#[derive(Debug, Deserialize, PartialEq)]
struct Answer {
    answer: String,
}

const API_KEY: &str = "sk-local-fake-key-7890";

fn schema() -> Value {
    json!({"type":"object","properties":{"answer":{"type":"string"},"note":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["answer"],"additionalProperties":false})
}

/// One captured HTTP request: path, lowercase header map, JSON body.
#[derive(Debug, Clone)]
struct Captured {
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

/// A canned reply: status, extra headers, body. `Hold` keeps the socket open
/// (the request is still captured) until the fixture is dropped.
enum Reply {
    Json(u16, Vec<(&'static str, String)>, Value),
    Raw(u16, Vec<(&'static str, String)>, String),
    Hold,
}

struct Fixture {
    base_url: String,
    requests: mpsc::UnboundedReceiver<Captured>,
    _release: Arc<Notify>,
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Captured {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = socket.read(&mut chunk).await.unwrap();
        assert!(n > 0, "client closed before sending headers");
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap();
    let path = request_line.split_whitespace().nth(1).unwrap().to_string();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .map(|v| v.parse().unwrap())
        .unwrap_or(0);
    let mut body = buf[header_end..].to_vec();
    while body.len() < length {
        let n = socket.read(&mut chunk).await.unwrap();
        assert!(n > 0);
        body.extend_from_slice(&chunk[..n]);
    }
    let body = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    Captured {
        path,
        headers,
        body,
    }
}

async fn serve(replies: Vec<Reply>) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let hold = release.clone();
    tokio::spawn(async move {
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let captured = read_request(&mut socket).await;
            tx.send(captured).unwrap();
            let (status, headers, body) = match reply {
                Reply::Json(s, h, v) => (s, h, v.to_string()),
                Reply::Raw(s, h, b) => (s, h, b),
                Reply::Hold => {
                    let hold = hold.clone();
                    tokio::spawn(async move {
                        hold.notified().await;
                        drop(socket);
                    });
                    continue;
                }
            };
            let mut response = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
                body.len()
            );
            for (k, v) in headers {
                response.push_str(&format!("{k}: {v}\r\n"));
            }
            response.push_str("\r\n");
            response.push_str(&body);
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.ok();
        }
    });
    Fixture {
        base_url,
        requests: rx,
        _release: release,
    }
}

fn provider(name: &str, api_key: Option<&str>, base_url: Option<&str>) -> ResolvedProvider {
    ResolvedProvider {
        name: name.into(),
        model: Some("fake-model".into()),
        api_key: api_key.map(Into::into),
        base_url: base_url.map(Into::into),
    }
}
fn llm_with_env(p: ResolvedProvider, env: &[(&str, &str)]) -> Llm {
    let env: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Llm::new(LlmConfig::Provider(p), &env).unwrap()
}
fn chat(llm: &Llm) -> Conversation {
    let mut c = llm.start_conversation(ConversationOptions {
        system: "sys".into(),
        format_echo: None,
    });
    c.add(
        LlmMessage {
            role: Role::User,
            content: "q".into(),
        },
        false,
    );
    c.add(
        LlmMessage {
            role: Role::Assistant,
            content: "a".into(),
        },
        false,
    );
    c.add(
        LlmMessage {
            role: Role::User,
            content: "q2".into(),
        },
        false,
    );
    c
}
async fn send(c: &mut Conversation) -> Result<Answer, LlmError> {
    c.send::<Answer>(&schema(), SendOptions::default()).await
}
fn completion(content: &str) -> Value {
    json!({
        "id": "chatcmpl-1", "object": "chat.completion", "model": "fake-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12}
    })
}

#[tokio::test]
async fn anthropic_posts_the_messages_api_shape_with_key_header() {
    let mut fx = serve(vec![Reply::Json(
        200,
        vec![],
        json!({"id": "msg_1", "content": [{"type": "text", "text": "ignored"}, {"type": "text", "text": "{\"answer\":\"hi\"}"}],
               "stop_reason": "end_turn", "usage": {"input_tokens": 3, "output_tokens": 4}}),
    )])
    .await;
    let llm = llm_with_env(
        provider("anthropic", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    assert_eq!(send(&mut c).await.unwrap().answer, "hi");

    let req = fx.requests.recv().await.unwrap();
    assert_eq!(req.path, "/v1/messages");
    assert_eq!(req.headers["x-api-key"], API_KEY);
    assert_eq!(req.headers["anthropic-version"], "2023-06-01");
    assert!(!req.headers.contains_key("authorization"));
    assert_eq!(req.body["model"], "fake-model");
    assert_eq!(req.body["system"], "sys");
    assert_eq!(req.body["max_tokens"], 16000);
    assert_eq!(
        req.body["messages"],
        json!([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}, {"role": "user", "content": "q2"}])
    );
    assert_eq!(req.body["output_config"]["format"]["type"], "json_schema");
    assert_eq!(req.body["output_config"]["format"]["schema"], schema());

    let attempt = &c.entries()[3].attempts[0];
    match attempt.request_wire.as_ref().unwrap() {
        WireRequest::Http { body } => {
            assert!(body.get("system").is_none());
            assert!(body.get("messages").is_none());
            assert_eq!(body["model"], "fake-model");
            assert_eq!(body["max_tokens"], 16000);
        }
        other => panic!("{other:?}"),
    }
    match attempt.response_wire.as_ref().unwrap() {
        WireResponse::Http {
            body,
            usage,
            finish_reason,
        } => {
            assert_eq!(body["id"], "msg_1");
            assert_eq!(usage.as_ref().unwrap()["output_tokens"], 4);
            assert_eq!(finish_reason.as_deref(), Some("end_turn"));
        }
        other => panic!("{other:?}"),
    }
    assert!(!serde_json::to_string(attempt).unwrap().contains(API_KEY));
}

#[tokio::test]
async fn openai_posts_the_responses_api_shape_with_a_strict_schema() {
    let mut fx = serve(vec![Reply::Json(
        200,
        vec![],
        json!({"id": "resp_1", "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": "{\"answer\":"}, {"type": "output_text", "text": "\"hi\"}"}]}
        ], "usage": {"input_tokens": 1}}),
    )])
    .await;
    let llm = llm_with_env(provider("openai", Some(API_KEY), Some(&fx.base_url)), &[]);
    let mut c = chat(&llm);
    assert_eq!(send(&mut c).await.unwrap().answer, "hi");

    let req = fx.requests.recv().await.unwrap();
    assert_eq!(req.path, "/v1/responses");
    assert_eq!(req.headers["authorization"], format!("Bearer {API_KEY}"));
    assert_eq!(req.body["instructions"], "sys");
    assert_eq!(
        req.body["input"][2],
        json!({"role": "user", "content": "q2"})
    );
    let format = &req.body["text"]["format"];
    assert_eq!(format["type"], "json_schema");
    assert_eq!(format["name"], "wrap_response");
    assert_eq!(format["strict"], true);
    assert_eq!(format["schema"]["required"], json!(["answer", "note"]));
    assert_eq!(format["schema"]["additionalProperties"], false);

    match c.entries()[3].attempts[0].request_wire.as_ref().unwrap() {
        WireRequest::Http { body } => {
            assert!(body.get("instructions").is_none());
            assert!(body.get("input").is_none());
            assert_eq!(body["text"]["format"]["name"], "wrap_response");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn chat_completions_kinds_pick_response_format_by_provider() {
    // groq: strict json_schema; openrouter: json_schema without strict;
    // unknown: json_object; ollama without a key: bearer nokey.
    let bearer = format!("Bearer {API_KEY}");
    let cases: Vec<(ResolvedProvider, Value, String)> = vec![
        (
            provider("groq", Some(API_KEY), None),
            json!({"type": "json_schema", "json_schema": {"name": "wrap_response", "schema": wrap::llm::strict_schema(&schema()), "strict": true}}),
            bearer.clone(),
        ),
        (
            provider("openrouter", Some(API_KEY), None),
            json!({"type": "json_schema", "json_schema": {"name": "wrap_response", "schema": schema()}}),
            bearer.clone(),
        ),
        (
            provider("custom-endpoint", Some(API_KEY), None),
            json!({"type": "json_object"}),
            bearer.clone(),
        ),
        (
            provider("ollama", None, None),
            json!({"type": "json_schema", "json_schema": {"name": "wrap_response", "schema": wrap::llm::strict_schema(&schema()), "strict": true}}),
            "Bearer nokey".to_string(),
        ),
    ];
    for (mut p, expected_format, auth) in cases {
        let mut fx = serve(vec![Reply::Json(
            200,
            vec![],
            completion("{\"answer\":\"hi\"}"),
        )])
        .await;
        p.base_url = Some(fx.base_url.clone());
        let name = p.name.clone();
        let llm = llm_with_env(p, &[]);
        let mut c = chat(&llm);
        assert_eq!(send(&mut c).await.unwrap().answer, "hi", "{name}");
        let req = fx.requests.recv().await.unwrap();
        assert_eq!(req.path, "/v1/chat/completions", "{name}");
        assert_eq!(req.headers["authorization"], auth, "{name}");
        assert_eq!(
            req.body["messages"][0],
            json!({"role": "system", "content": "sys"}),
            "{name}"
        );
        assert_eq!(
            req.body["messages"][3],
            json!({"role": "user", "content": "q2"}),
            "{name}"
        );
        assert_eq!(req.body["response_format"], expected_format, "{name}");
        match c.entries()[3].attempts[0].response_wire.as_ref().unwrap() {
            WireResponse::Http {
                usage,
                finish_reason,
                ..
            } => {
                assert_eq!(finish_reason.as_deref(), Some("stop"));
                assert_eq!(usage.as_ref().unwrap()["total_tokens"], 12);
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn env_fallbacks_supply_keys_and_base_urls_and_missing_keys_fail_plainly() {
    let mut fx = serve(vec![Reply::Json(
        200,
        vec![],
        completion("{\"answer\":\"hi\"}"),
    )])
    .await;
    let llm = llm_with_env(
        provider("openai", None, None),
        &[
            ("OPENAI_API_KEY", "sk-env-key-4321"),
            ("OPENAI_BASE_URL", &fx.base_url),
        ],
    );
    // The Responses API path is still used; the fixture only cares about auth.
    let mut c = chat(&llm);
    let _ = send(&mut c).await;
    let req = fx.requests.recv().await.unwrap();
    assert_eq!(req.path, "/v1/responses");
    assert_eq!(req.headers["authorization"], "Bearer sk-env-key-4321");
    assert!(
        !serde_json::to_string(c.entries())
            .unwrap()
            .contains("sk-env-key-4321")
    );

    let keyless = llm_with_env(
        provider("anthropic", None, Some("http://127.0.0.1:9/v1")),
        &[],
    );
    let mut c = chat(&keyless);
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => {
            assert!(
                message.contains("anthropic") && message.contains("API key"),
                "{message}"
            )
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(c.entries()[3].attempts.len(), 1);
}

#[tokio::test]
async fn http_errors_are_provider_errors_with_scrubbed_wires_and_messages() {
    let fx = serve(vec![Reply::Json(
        401,
        vec![],
        json!({"error": {"message": format!("Invalid API key: {API_KEY}"), "type": "invalid_request_error"}}),
    )])
    .await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    let err = send(&mut c).await.unwrap_err();
    let LlmError::Provider { message } = &err else {
        panic!("{err:?}")
    };
    assert!(
        message.starts_with("Provider returned HTTP 401"),
        "{message}"
    );
    assert!(!message.contains(API_KEY));
    assert!(message.contains("...7890"));

    let entry = &c.entries()[3];
    assert_eq!(entry.message, None);
    assert_eq!(entry.attempts.len(), 1);
    let attempt = &entry.attempts[0];
    assert_eq!(
        attempt.error.as_ref().unwrap().kind,
        AttemptErrorKind::Provider
    );
    assert!(
        matches!(attempt.request_wire, Some(WireRequest::Http { ref body }) if body["model"] == "fake-model")
    );
    match attempt.response_wire.as_ref().unwrap() {
        WireResponse::Http { body, .. } => {
            assert_eq!(body["error"]["message"], "Invalid API key: ...7890")
        }
        other => panic!("{other:?}"),
    }
    assert!(!serde_json::to_string(entry).unwrap().contains(API_KEY));
}

#[tokio::test]
async fn non_json_success_bodies_and_missing_text_are_provider_errors() {
    let fx = serve(vec![Reply::Raw(200, vec![], "<html>oops</html>".into())]).await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => {
            assert_eq!(message, "Provider response was not valid JSON.")
        }
        other => panic!("{other:?}"),
    }

    let fx = serve(vec![Reply::Json(200, vec![], json!({"choices": []}))]).await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => {
            assert_eq!(message, "Model returned no structured output.")
        }
        other => panic!("{other:?}"),
    }
    match c.entries()[3].attempts[0].response_wire.as_ref().unwrap() {
        WireResponse::Http { body, .. } => assert_eq!(body["choices"], json!([])),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn retries_429_honouring_retry_after_within_one_attempt() {
    let mut fx = serve(vec![
        Reply::Json(
            429,
            vec![("retry-after-ms", "5".into())],
            json!({"error": "slow down"}),
        ),
        Reply::Json(
            503,
            vec![("retry-after", "0".into())],
            json!({"error": "down"}),
        ),
        Reply::Json(200, vec![], completion("{\"answer\":\"hi\"}")),
    ])
    .await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    assert_eq!(send(&mut c).await.unwrap().answer, "hi");
    for _ in 0..3 {
        fx.requests.recv().await.unwrap();
    }
    assert_eq!(c.entries()[3].attempts.len(), 1);
    assert!(c.entries()[3].attempts[0].error.is_none());
}

#[tokio::test]
async fn gives_up_after_three_rate_limited_responses() {
    let fx = serve(vec![
        Reply::Json(
            429,
            vec![("retry-after-ms", "1".into())],
            json!({"error": "a"}),
        ),
        Reply::Json(
            429,
            vec![("retry-after-ms", "1".into())],
            json!({"error": "b"}),
        ),
        Reply::Json(
            429,
            vec![("retry-after-ms", "1".into())],
            json!({"error": "c"}),
        ),
    ])
    .await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => assert!(
            message.starts_with("Provider returned HTTP 429"),
            "{message}"
        ),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn abort_mid_request_seals_the_entry_with_no_attempts() {
    let mut fx = serve(vec![
        Reply::Hold,
        Reply::Json(200, vec![], completion("{\"answer\":\"fresh\"}")),
    ])
    .await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let schema = schema();
    let pending = c.send::<Answer>(
        &schema,
        SendOptions {
            cancel: Some(cancel),
            retry: true,
        },
    );
    let first = async {
        let req = fx.requests.recv().await.unwrap();
        trigger.cancel();
        req
    };
    let (result, req) = tokio::join!(pending, first);
    assert_eq!(req.path, "/v1/chat/completions");
    assert!(matches!(result, Err(LlmError::Aborted)));
    assert_eq!(c.entries().len(), 4);
    assert_eq!(c.entries()[3].message, None);
    assert!(c.entries()[3].attempts.is_empty());

    assert_eq!(send(&mut c).await.unwrap().answer, "fresh");
    assert_eq!(c.entries().len(), 5);
}

#[tokio::test]
async fn redirects_off_the_provider_origin_are_refused() {
    let fx = serve(vec![Reply::Raw(
        302,
        vec![("location", "http://127.0.0.1:9/v1/chat/completions".into())],
        String::new(),
    )])
    .await;
    let llm = llm_with_env(
        provider("local-fake", Some(API_KEY), Some(&fx.base_url)),
        &[],
    );
    let mut c = chat(&llm);
    match send(&mut c).await {
        Err(LlmError::Provider { message }) => assert!(message.contains("redirect"), "{message}"),
        other => panic!("{other:?}"),
    }
}
