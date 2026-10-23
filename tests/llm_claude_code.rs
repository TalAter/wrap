use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use wrap::llm::{
    AttemptErrorKind, Conversation, ConversationOptions, Llm, LlmConfig, LlmError, LlmMessage,
    ResolvedProvider, Role, SendOptions, WireRequest, WireResponse,
};

#[derive(Debug, Deserialize, PartialEq)]
struct Answer {
    answer: String,
}

fn schema() -> Value {
    json!({"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]})
}

/// Install a fake `claude` on a private PATH. The script records argv
/// (NUL-separated), stdin, and cwd next to itself and replays canned
/// stdout/stderr/exit from sibling files.
fn install_fake(dir: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let script = format!(
        "#!/bin/sh\ndir=$(dirname \"$0\")\nprintf '%s\\0' \"$@\" > \"$dir/argv\"\ncat > \"$dir/stdin\"\npwd > \"$dir/cwd\"\n{body}\n"
    );
    let path = dir.join("claude");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn llm(dir: &Path, model: Option<&str>) -> Llm {
    let env: HashMap<String, String> =
        HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())]);
    Llm::new(
        LlmConfig::Provider(ResolvedProvider {
            name: "claude-code".into(),
            model: model.map(Into::into),
            api_key: None,
            base_url: None,
        }),
        &env,
    )
    .unwrap()
}

fn chat(llm: &Llm) -> Conversation {
    let mut c = llm.start_conversation(ConversationOptions {
        system: "the system prompt".into(),
        format_echo: None,
    });
    for (role, content) in [
        (Role::User, "q1"),
        (Role::Assistant, "a1"),
        (Role::User, "q2"),
    ] {
        c.add(
            LlmMessage {
                role,
                content: content.into(),
            },
            false,
        );
    }
    c
}

fn argv(dir: &Path) -> Vec<String> {
    let raw = std::fs::read_to_string(dir.join("argv")).unwrap();
    let mut args: Vec<String> = raw.split('\0').map(str::to_string).collect();
    assert_eq!(args.pop().as_deref(), Some(""));
    args
}

#[tokio::test]
async fn runs_the_cli_with_flattened_stdin_in_the_temp_dir_and_returns_trimmed_stdout() {
    let dir = tempfile::tempdir().unwrap();
    install_fake(dir.path(), "printf '{\"answer\":\"ok\"}\\n'");
    let l = llm(dir.path(), Some("haiku"));
    let mut c = chat(&l);
    assert_eq!(
        c.send::<Answer>(&schema(), SendOptions::default())
            .await
            .unwrap()
            .answer,
        "ok"
    );
    assert_eq!(
        argv(dir.path()),
        vec![
            "--tools",
            "",
            "--system-prompt",
            "the system prompt",
            "--model",
            "haiku",
            "--no-session-persistence",
            "--json-schema",
            &schema().to_string(),
            "-p",
        ]
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("stdin")).unwrap(),
        "User: q1\n\nAssistant: a1\n\nUser: q2"
    );
    let cwd = std::fs::read_to_string(dir.path().join("cwd")).unwrap();
    assert_eq!(
        Path::new(cwd.trim()).canonicalize().unwrap(),
        std::env::temp_dir().canonicalize().unwrap()
    );
    let attempt = &c.entries()[3].attempts[0];
    assert_eq!(attempt.raw_text.as_deref(), Some("{\"answer\":\"ok\"}"));
    match attempt.request_wire.as_ref().unwrap() {
        WireRequest::Subprocess { argv, stdin } => {
            assert_eq!(argv[0], "claude");
            assert_eq!(argv.last().unwrap(), "-p");
            assert_eq!(stdin, "User: q1\n\nAssistant: a1\n\nUser: q2");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        attempt.response_wire,
        Some(WireResponse::Subprocess {
            stdout: "{\"answer\":\"ok\"}\n".into(),
            stderr: None,
            exit_code: 0
        })
    );
}

#[tokio::test]
async fn omits_model_when_the_entry_has_none() {
    let dir = tempfile::tempdir().unwrap();
    install_fake(dir.path(), "printf '{\"answer\":\"ok\"}'");
    let l = llm(dir.path(), None);
    let mut c = chat(&l);
    c.send::<Answer>(&schema(), SendOptions::default())
        .await
        .unwrap();
    let args = argv(dir.path());
    assert!(!args.iter().any(|a| a == "--model"));
    assert_eq!(args.last().unwrap(), "-p");
}

#[tokio::test]
async fn nonzero_exit_is_a_provider_error_carrying_stderr_and_wires() {
    let dir = tempfile::tempdir().unwrap();
    install_fake(dir.path(), "echo 'Not logged in' >&2; exit 1");
    let l = llm(dir.path(), None);
    let mut c = chat(&l);
    match c.send::<Answer>(&schema(), SendOptions::default()).await {
        Err(LlmError::Provider { message }) => assert_eq!(message, "Not logged in"),
        other => panic!("{other:?}"),
    }
    let attempt = &c.entries()[3].attempts[0];
    assert_eq!(
        attempt.error.as_ref().unwrap().kind,
        AttemptErrorKind::Provider
    );
    assert_eq!(
        attempt.response_wire,
        Some(WireResponse::Subprocess {
            stdout: String::new(),
            stderr: Some("Not logged in\n".into()),
            exit_code: 1
        })
    );
    assert!(matches!(
        attempt.request_wire,
        Some(WireRequest::Subprocess { .. })
    ));

    let silent = tempfile::tempdir().unwrap();
    install_fake(silent.path(), "exit 7");
    let l = llm(silent.path(), None);
    let mut c = chat(&l);
    match c.send::<Answer>(&schema(), SendOptions::default()).await {
        Err(LlmError::Provider { message }) => assert_eq!(message, "claude exited with code 7."),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn abort_kills_the_subprocess_and_seals_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    install_fake(dir.path(), "sleep 5; printf '{\"answer\":\"late\"}'");
    let l = llm(dir.path(), None);
    let mut c = chat(&l);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        trigger.cancel();
    });
    let started = Instant::now();
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
    assert!(started.elapsed().as_secs() < 2);
    assert_eq!(c.entries()[3].message, None);
    assert!(c.entries()[3].attempts.is_empty());
}

#[tokio::test]
async fn a_missing_binary_is_a_plain_provider_error() {
    let dir = tempfile::tempdir().unwrap();
    let l = llm(dir.path(), None);
    let mut c = chat(&l);
    match c.send::<Answer>(&schema(), SendOptions::default()).await {
        Err(LlmError::Provider { message }) => assert!(message.contains("claude"), "{message}"),
        other => panic!("{other:?}"),
    }
}
