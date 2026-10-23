use std::collections::BTreeMap;
use std::fs;

use serde_json::{Value, json};
use wrap::home::WrapHome;
use wrap::logging::{
    AttachedInputParams, AttemptError, AttemptErrorKind, AttemptMeta, CommandResponse, LogEntry,
    LogEntryParams, LoggedRequest, ResolvedProvider, ResponseType, RiskLevel, Turn, WireRequest,
    WireResponse, append_log_entry, assemble_continuation_chain, find_continuation_parent,
    read_log_entries,
};
use wrap::memory::{Fact, Memory};

fn provider() -> ResolvedProvider {
    ResolvedProvider {
        name: "claude-code".into(),
        model: Some("haiku".into()),
        api_key: None,
        base_url: None,
    }
}

fn params() -> LogEntryParams {
    LogEntryParams {
        cwd: "/Users/tal/projects".into(),
        attached_input: None,
        memory: None,
        provider: provider(),
        prompt_hash: "abc123".into(),
        input_source: None,
        ppid: None,
    }
}

fn entry() -> LogEntry {
    LogEntry::create(params())
}

fn command_response(content: &str) -> CommandResponse {
    CommandResponse {
        scratchpad: None,
        kind: ResponseType::Command,
        is_final: true,
        plan: None,
        content: content.into(),
        risk_level: RiskLevel::Low,
        explanation: None,
        memory_updates: None,
        memory_updates_message: None,
        watchlist_additions: None,
    }
}

fn assistant(response: Option<CommandResponse>, attempts: Vec<AttemptMeta>) -> Turn {
    Turn::Assistant {
        response,
        attempts,
        llm_ms: None,
        source: "model".into(),
    }
}

fn user(text: &str) -> Turn {
    Turn::User { text: text.into() }
}

fn traced_attempt() -> AttemptMeta {
    AttemptMeta {
        request_wire: Some(WireRequest::Test),
        ..AttemptMeta::default()
    }
}

fn to_json(entry: &LogEntry) -> Value {
    serde_json::from_str(&entry.to_jsonl_line()).unwrap()
}

fn home() -> (tempfile::TempDir, WrapHome) {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    (dir, home)
}

fn read_lines(home: &WrapHome) -> Vec<Value> {
    let content = fs::read_to_string(home.resolve("logs/wrap.jsonl")).unwrap();
    content
        .trim_end()
        .split('\n')
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

// --- create ---------------------------------------------------------------

#[test]
fn create_stamps_id_timestamp_version_and_defaults() {
    let e = entry();
    let uuid =
        regex::Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .unwrap();
    assert!(uuid.is_match(&e.id), "{}", e.id);
    let iso = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$").unwrap();
    assert!(iso.is_match(&e.timestamp), "{}", e.timestamp);
    assert!(!e.version.is_empty());
    assert_eq!(e.cwd, "/Users/tal/projects");
    assert_eq!(e.provider, provider());
    assert_eq!(e.prompt_hash, "abc123");
    assert!(e.turns.is_empty());
    assert_eq!(e.outcome, "error");
    assert_eq!(e.ppid, std::os::unix::process::parent_id());
    assert_eq!(e.parent_id, None);
    assert_eq!(e.attached_input, None);
    assert_eq!(e.memory, None);
    assert_eq!(e.input_source, None);
}

#[test]
fn create_honours_ppid_override_and_input_source() {
    let e = LogEntry::create(LogEntryParams {
        ppid: Some(4242),
        input_source: Some("pipe".into()),
        ..params()
    });
    assert_eq!(e.ppid, 4242);
    assert_eq!(e.input_source.as_deref(), Some("pipe"));
    assert_eq!(to_json(&e)["ppid"], 4242);
    assert_eq!(to_json(&e)["input_source"], "pipe");
}

#[test]
fn create_records_attached_input_and_truncates_the_preview_at_1000_chars() {
    let short = LogEntry::create(LogEntryParams {
        attached_input: Some(AttachedInputParams {
            path: "/tmp/wrap-scratch-abc/input".into(),
            size: 11,
            preview: "hello world".into(),
        }),
        ..params()
    });
    let rec = short.attached_input.unwrap();
    assert_eq!(rec.path, "/tmp/wrap-scratch-abc/input");
    assert_eq!(rec.size, 11);
    assert_eq!(rec.preview, "hello world");

    let exact = LogEntry::create(LogEntryParams {
        attached_input: Some(AttachedInputParams {
            path: "p".into(),
            size: 1000,
            preview: "x".repeat(1000),
        }),
        ..params()
    });
    assert_eq!(exact.attached_input.unwrap().preview, "x".repeat(1000));

    let long = LogEntry::create(LogEntryParams {
        attached_input: Some(AttachedInputParams {
            path: "p".into(),
            size: 5000,
            preview: "é".repeat(5000),
        }),
        ..params()
    });
    let preview = long.attached_input.unwrap().preview;
    assert_eq!(
        preview,
        format!("{}\n[…truncated, 5000 chars total]", "é".repeat(1000))
    );
}

#[test]
fn create_keeps_memory_only_when_non_empty() {
    let mut memory: Memory = BTreeMap::new();
    memory.insert(
        "/".into(),
        vec![Fact {
            fact: "macOS".into(),
        }],
    );
    let with = LogEntry::create(LogEntryParams {
        memory: Some(memory.clone()),
        ..params()
    });
    assert_eq!(with.memory, Some(memory));
    let empty = LogEntry::create(LogEntryParams {
        memory: Some(BTreeMap::new()),
        ..params()
    });
    assert_eq!(empty.memory, None);
    assert!(to_json(&empty).get("memory").is_none());
}

#[test]
fn create_redacts_the_provider_api_key() {
    let redacted = |key: &str| {
        LogEntry::create(LogEntryParams {
            provider: ResolvedProvider {
                name: "anthropic".into(),
                model: Some("claude-haiku-4-5".into()),
                api_key: Some(key.into()),
                base_url: None,
            },
            ..params()
        })
        .provider
        .api_key
    };
    assert_eq!(
        redacted("sk-ant-api03-xxxxxxxxxxxxxxxxxxxx-abcd").as_deref(),
        Some("...abcd")
    );
    assert_eq!(redacted("ab").as_deref(), Some("..."));
    assert_eq!(redacted("abcd").as_deref(), Some("...abcd"));
    assert_eq!(entry().provider, provider());
}

// --- serialize ------------------------------------------------------------

#[test]
fn serialized_line_is_single_line_json_omitting_absent_fields() {
    let line = entry().to_jsonl_line();
    assert!(!line.contains('\n'));
    let json: Value = serde_json::from_str(&line).unwrap();
    let obj = json.as_object().unwrap();
    for absent in ["attached_input", "parent_id", "memory", "input_source"] {
        assert!(!obj.contains_key(absent), "{absent} should be omitted");
    }
    assert_eq!(
        json["provider"],
        json!({"name": "claude-code", "model": "haiku"})
    );
    assert_eq!(json["outcome"], "error");
    assert_eq!(json["turns"], json!([]));
}

#[test]
fn turns_serialize_with_the_kind_tag_and_snake_case_fields() {
    let mut e = entry();
    e.outcome = "success".into();
    e.turns.push(user("list"));
    e.turns.push(Turn::Assistant {
        response: Some(command_response("ls")),
        attempts: vec![AttemptMeta {
            llm_ms: Some(5),
            ..AttemptMeta::default()
        }],
        llm_ms: Some(5),
        source: "model".into(),
    });
    e.turns.push(Turn::Step {
        command: "echo x".into(),
        exit_code: 0,
        output: "x\n".into(),
        shell: "/bin/sh".into(),
        source: "model".into(),
        exec_ms: None,
    });
    e.turns.push(Turn::Probe {
        skill: "discovery".into(),
        command: "pwd".into(),
        output: "/".into(),
    });
    e.turns.push(Turn::Final {
        command: "ls".into(),
        exit_code: Some(0),
        shell: Some("/bin/zsh".into()),
        source: "model".into(),
        exec_ms: Some(3),
    });
    let json = to_json(&e);
    assert_eq!(json["turns"][0], json!({"kind": "user", "text": "list"}));
    assert_eq!(
        json["turns"][1],
        json!({
            "kind": "assistant",
            "response": {"type": "command", "final": true, "content": "ls", "risk_level": "low"},
            "attempts": [{"llm_ms": 5}],
            "llm_ms": 5,
            "source": "model"
        })
    );
    assert_eq!(
        json["turns"][2],
        json!({"kind": "step", "command": "echo x", "exit_code": 0, "output": "x\n", "shell": "/bin/sh", "source": "model"})
    );
    assert_eq!(
        json["turns"][3],
        json!({"kind": "probe", "skill": "discovery", "command": "pwd", "output": "/"})
    );
    assert_eq!(
        json["turns"][4],
        json!({"kind": "final", "command": "ls", "exit_code": 0, "shell": "/bin/zsh", "source": "model", "exec_ms": 3})
    );
}

#[test]
fn final_turn_without_execution_serializes_exit_code_as_null() {
    let mut e = entry();
    e.turns.push(Turn::Final {
        command: "echo rm-rf-fake".into(),
        exit_code: None,
        shell: None,
        source: "blocked".into(),
        exec_ms: None,
    });
    assert_eq!(
        to_json(&e)["turns"][0],
        json!({"kind": "final", "command": "echo rm-rf-fake", "exit_code": null, "source": "blocked"})
    );
}

#[test]
fn failed_rounds_keep_attempt_errors_and_omit_the_response() {
    let mut e = entry();
    e.turns.push(assistant(
        None,
        vec![
            AttemptMeta {
                error: Some(AttemptError {
                    kind: AttemptErrorKind::Provider,
                    message: "rate limit".into(),
                }),
                llm_ms: Some(12),
                ..AttemptMeta::default()
            },
            AttemptMeta {
                error: Some(AttemptError {
                    kind: AttemptErrorKind::Parse,
                    message: "bad json".into(),
                }),
                raw_response: Some("oops".into()),
                ..AttemptMeta::default()
            },
        ],
    ));
    let turn = &to_json(&e)["turns"][0];
    assert!(turn.get("response").is_none());
    assert_eq!(
        turn["attempts"],
        json!([
            {"error": {"kind": "provider", "message": "rate limit"}, "llm_ms": 12},
            {"raw_response": "oops", "error": {"kind": "parse", "message": "bad json"}}
        ])
    );
}

#[test]
fn wire_shapes_serialize_with_their_kind_tags() {
    let mut e = entry();
    e.turns.push(assistant(
        None,
        vec![AttemptMeta {
            request: Some(LoggedRequest {
                system: "sys".into(),
                messages: vec![],
            }),
            request_wire: Some(WireRequest::Subprocess {
                argv: vec!["claude".into()],
                stdin: "hi".into(),
            }),
            response_wire: Some(WireResponse::Subprocess {
                stdout: "out".into(),
                stderr: None,
                exit_code: 0,
            }),
            ..AttemptMeta::default()
        }],
    ));
    let json = serde_json::to_value(&e.turns[0]).unwrap();
    assert_eq!(
        json["attempts"][0]["request"],
        json!({"system": "sys", "messages": []})
    );
    assert_eq!(
        json["attempts"][0]["request_wire"],
        json!({"kind": "subprocess", "argv": ["claude"], "stdin": "hi"})
    );
    assert_eq!(
        json["attempts"][0]["response_wire"],
        json!({"kind": "subprocess", "stdout": "out", "exit_code": 0})
    );
    let http = serde_json::to_value(WireResponse::Http {
        body: json!({"a": 1}),
        usage: None,
        finish_reason: Some("stop".into()),
    })
    .unwrap();
    assert_eq!(
        http,
        json!({"kind": "http", "body": {"a": 1}, "finishReason": "stop"})
    );
}

#[test]
fn entries_written_by_the_previous_version_still_load() {
    let line = r#"{"id":"old-1","timestamp":"2026-04-01T10:00:00.000Z","version":"0.0.5","cwd":"/tmp","ppid":77,"provider":{"name":"anthropic","model":"haiku","apiKey":"...abcd"},"prompt_hash":"h","turns":[{"kind":"probe","skill":"discovery","command":"pwd","output":"/tmp"},{"kind":"user","text":"hi"},{"kind":"assistant","response":{"_scratchpad":null,"type":"reply","content":"hello","risk_level":"low","final":true,"future_field":1},"attempts":[{"raw_response":"x","error":{"kind":"empty","message":"m"},"unknown":true}],"llm_ms":3,"source":"model"},{"kind":"final","command":"","exit_code":null,"source":"exhausted"}],"outcome":"max_rounds","memory":{"/":[{"fact":"f"}]},"attached_input":{"path":"/p","size":2,"preview":"ab"},"input_source":"argv","parent_id":"old-0","future_top_level":{"x":1}}"#;
    let (_dir, home) = home();
    home.append("logs/wrap.jsonl", &format!("{line}\n"))
        .unwrap();
    let entries = read_log_entries(&home);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.id, "old-1");
    assert_eq!(e.ppid, 77);
    assert_eq!(e.provider.api_key.as_deref(), Some("...abcd"));
    assert_eq!(e.outcome, "max_rounds");
    assert_eq!(e.parent_id.as_deref(), Some("old-0"));
    assert_eq!(e.turns.len(), 4);
    match &e.turns[2] {
        Turn::Assistant {
            response,
            attempts,
            llm_ms,
            ..
        } => {
            assert_eq!(response.as_ref().unwrap().kind, ResponseType::Reply);
            assert_eq!(
                attempts[0].error.as_ref().unwrap().kind,
                AttemptErrorKind::Empty
            );
            assert_eq!(*llm_ms, Some(3));
        }
        other => panic!("expected assistant, got {other:?}"),
    }
    assert!(matches!(
        &e.turns[3],
        Turn::Final {
            exit_code: None,
            ..
        }
    ));
}

#[test]
fn minimal_old_entry_without_optional_fields_loads() {
    let line = r#"{"id":"min","timestamp":"t","version":"v","cwd":"/","provider":{"name":"test"},"prompt_hash":"h","turns":[],"outcome":"success"}"#;
    let (_dir, home) = home();
    home.append("logs/wrap.jsonl", &format!("{line}\n"))
        .unwrap();
    let entries = read_log_entries(&home);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].ppid, 0);
}

// --- append ---------------------------------------------------------------

#[test]
fn append_creates_the_log_and_writes_one_json_line_per_entry() {
    let (_dir, home) = home();
    let mut a = entry();
    let mut b = entry();
    append_log_entry(&home, &mut a).unwrap();
    append_log_entry(&home, &mut b).unwrap();
    let lines = read_lines(&home);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["id"], a.id);
    assert_eq!(lines[1]["id"], b.id);
    assert_ne!(a.id, b.id);
}

#[test]
fn append_moves_trace_fields_to_a_sidecar_keyed_by_turn_index() {
    let (_dir, home) = home();
    let mut e = entry();
    e.turns.push(user("first"));
    e.turns.push(user("second"));
    e.turns.push(assistant(
        Some(command_response("ls")),
        vec![AttemptMeta {
            request: Some(LoggedRequest {
                system: "sys".into(),
                messages: vec![],
            }),
            request_wire: Some(WireRequest::Test),
            response_wire: Some(WireResponse::Test),
            raw_response: Some("{\"type\":\"command\"}".into()),
            llm_ms: Some(9),
            ..AttemptMeta::default()
        }],
    ));
    e.turns.push(Turn::Step {
        command: "echo x".into(),
        exit_code: 0,
        output: String::new(),
        shell: "/bin/sh".into(),
        source: "model".into(),
        exec_ms: None,
    });
    e.turns.push(assistant(
        None,
        vec![traced_attempt(), AttemptMeta::default()],
    ));
    append_log_entry(&home, &mut e).unwrap();

    let inline = &read_lines(&home)[0];
    let attempt = &inline["turns"][2]["attempts"][0];
    assert_eq!(attempt, &json!({"llm_ms": 9}));
    assert_eq!(inline["turns"][4]["attempts"], json!([{}, {}]));

    let trace: Value = serde_json::from_str(
        &fs::read_to_string(home.resolve(&format!("logs/traces/{}.json", e.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(trace["entry_id"], e.id);
    let mut keys: Vec<&String> = trace["turn_attempts"].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["2", "4"]);
    assert_eq!(
        trace["turn_attempts"]["2"][0],
        json!({"request": {"system": "sys", "messages": []}, "request_wire": {"kind": "test"}, "response_wire": {"kind": "test"}, "raw_response": "{\"type\":\"command\"}"})
    );
    assert_eq!(
        trace["turn_attempts"]["4"],
        json!([{"request_wire": {"kind": "test"}}, {}])
    );
}

#[test]
fn parse_failure_raw_response_stays_inline_and_writes_no_sidecar() {
    let (_dir, home) = home();
    let mut e = entry();
    e.turns.push(assistant(
        None,
        vec![AttemptMeta {
            raw_response: Some("garbage".into()),
            error: Some(AttemptError {
                kind: AttemptErrorKind::Parse,
                message: "bad json".into(),
            }),
            ..AttemptMeta::default()
        }],
    ));
    append_log_entry(&home, &mut e).unwrap();
    let inline = &read_lines(&home)[0];
    assert_eq!(inline["turns"][0]["attempts"][0]["raw_response"], "garbage");
    assert!(!home.exists(&format!("logs/traces/{}.json", e.id)));
    assert!(!home.exists("logs/traces"));
}

#[test]
fn sidecar_failure_surfaces_after_the_jsonl_line_is_durable() {
    let (_dir, home) = home();
    home.write("logs/traces", "").unwrap();
    let mut e = entry();
    e.turns.push(assistant(None, vec![traced_attempt()]));
    assert!(append_log_entry(&home, &mut e).is_err());
    assert_eq!(read_lines(&home)[0]["id"], e.id);
}

// --- read / lookup --------------------------------------------------------

#[test]
fn read_log_entries_handles_missing_empty_and_malformed_files() {
    let (_dir, home) = home();
    assert!(read_log_entries(&home).is_empty());
    home.write("logs/wrap.jsonl", "").unwrap();
    assert!(read_log_entries(&home).is_empty());
    let mut good = entry();
    good.id = "good".into();
    home.write(
        "logs/wrap.jsonl",
        &format!("garbage\n{}\n{{\"id\":1}}\ntrash\n", good.to_jsonl_line()),
    )
    .unwrap();
    let ids: Vec<String> = read_log_entries(&home).into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["good"]);
}

#[test]
fn read_log_entries_survives_non_utf8_bytes_elsewhere_in_the_log() {
    let (_dir, home) = home();
    let mut first = entry();
    first.id = "first".into();
    let mut second = entry();
    second.id = "second".into();
    let mut bytes = format!("{}\n", first.to_jsonl_line()).into_bytes();
    bytes.extend_from_slice(b"\xff\xfe not utf8\n");
    bytes.extend_from_slice(format!("{}\n", second.to_jsonl_line()).as_bytes());
    fs::create_dir_all(home.resolve("logs")).unwrap();
    fs::write(home.resolve("logs/wrap.jsonl"), bytes).unwrap();
    let ids: Vec<String> = read_log_entries(&home).into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["first", "second"]);
}

#[test]
fn a_bare_id_object_is_not_a_run_and_never_becomes_the_continuation_parent() {
    let (_dir, home) = home();
    let mut real = entry();
    real.id = "real".into();
    real.ppid = 4242;
    let lines = format!(
        "{}\n{{\"id\":\"garbage\"}}\n{{\"id\":\"no-turns\",\"timestamp\":\"2026-10-23T10:00:00.000Z\"}}\n{{\"id\":\"turns-not-array\",\"timestamp\":\"2026-10-23T10:00:00.000Z\",\"turns\":{{}}}}\n",
        real.to_jsonl_line()
    );
    home.write("logs/wrap.jsonl", &lines).unwrap();
    let entries = read_log_entries(&home);
    assert_eq!(entries.len(), 1);
    assert_eq!(find_continuation_parent(&entries, 4242).unwrap().id, "real");
    assert_eq!(find_continuation_parent(&entries, 9999).unwrap().id, "real");
}

fn with(id: &str, ppid: u32, parent_id: Option<&str>, turns: Vec<Turn>) -> LogEntry {
    let mut e = entry();
    e.id = id.into();
    e.ppid = ppid;
    e.parent_id = parent_id.map(str::to_string);
    e.turns = turns;
    e
}

#[test]
fn continuation_parent_prefers_the_newest_same_ppid_entry() {
    assert!(find_continuation_parent(&[], 1234).is_none());
    let entries = vec![
        with("a", 1111, None, vec![]),
        with("b", 2222, None, vec![]),
        with("c", 1111, None, vec![]),
        with("d", 3333, None, vec![]),
    ];
    assert_eq!(find_continuation_parent(&entries, 1111).unwrap().id, "c");
    assert_eq!(find_continuation_parent(&entries, 9999).unwrap().id, "d");
    let orphaned = vec![with("a", 1, None, vec![]), with("b", 5555, None, vec![])];
    assert_eq!(find_continuation_parent(&orphaned, 1).unwrap().id, "b");
}

#[test]
fn entries_with_turns_this_version_cannot_type_still_load_for_continuation() {
    let (_dir, home) = home();
    let mut older = entry();
    older.id = "older".into();
    older.ppid = 4242;
    older.turns = vec![user("older prompt")];
    let mut lines = format!("{}\n", older.to_jsonl_line());
    // A newer entry from the same shell: an unknown turn kind, an assistant
    // turn without `source`, and a response whose risk level is off-enum.
    lines.push_str(
        &json!({
            "id": "newer", "timestamp": "2026-10-23T10:00:00.000Z", "version": "9.9.9",
            "cwd": "/tmp", "ppid": 4242, "provider": {"name": "test"}, "prompt_hash": "h",
            "turns": [
                {"kind": "user", "text": "newer prompt"},
                {"kind": "mystery", "payload": 1},
                {"kind": "assistant", "attempts": []},
                {"kind": "assistant", "source": "model", "attempts": [],
                 "response": {"type": "command", "content": "echo x", "risk_level": "extreme"}},
                {"kind": "final", "command": "echo x", "exit_code": 0, "source": "model"}
            ],
            "outcome": "success"
        })
        .to_string(),
    );
    lines.push('\n');
    home.write("logs/wrap.jsonl", &lines).unwrap();

    let entries = read_log_entries(&home);
    assert_eq!(entries.len(), 2);
    let parent = find_continuation_parent(&entries, 4242).unwrap();
    assert_eq!(parent.id, "newer");
    assert_eq!(parent.ppid, 4242);
    assert_eq!(parent.outcome, "success");
    let kinds: Vec<&str> = parent
        .turns
        .iter()
        .map(|t| match t {
            Turn::User { .. } => "user",
            Turn::Assistant { .. } => "assistant",
            Turn::Step { .. } => "step",
            Turn::Probe { .. } => "probe",
            Turn::Final { .. } => "final",
        })
        .collect();
    assert_eq!(kinds, ["user", "final"]);
    assert_eq!(assemble_continuation_chain(&entries, parent).len(), 2);
}

#[test]
fn continuation_chain_walks_parent_ids_root_first() {
    let root = with("root", 1, None, vec![user("root prompt")]);
    let mid = with("mid", 1, Some("root"), vec![user("mid prompt")]);
    let parent = with(
        "parent",
        1,
        Some("mid"),
        vec![user("parent prompt"), assistant(None, vec![])],
    );
    let entries = vec![root, mid, parent.clone()];
    let turns = assemble_continuation_chain(&entries, &parent);
    let texts: Vec<&str> = turns
        .iter()
        .filter_map(|t| match t {
            Turn::User { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["root prompt", "mid prompt", "parent prompt"]);
    assert_eq!(turns.len(), 4);
}

#[test]
fn continuation_chain_truncates_on_missing_parents_and_survives_cycles() {
    let ghost = with("p", 1, Some("ghost"), vec![user("child")]);
    assert_eq!(
        assemble_continuation_chain(std::slice::from_ref(&ghost), &ghost),
        vec![user("child")]
    );

    let a = with("a", 1, Some("b"), vec![user("a")]);
    let b = with("b", 1, Some("a"), vec![user("b")]);
    let entries = vec![a.clone(), b];
    assert_eq!(
        assemble_continuation_chain(&entries, &a),
        vec![user("b"), user("a")]
    );
}
