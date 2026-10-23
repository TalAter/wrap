//! `-c` through the real binary: the chain is linked by `parent_id`, each
//! entry stores only its own turns, and the refusals exit before any LLM
//! call.

mod cli_binary_common;

use cli_binary_common::{Wrap, command, reply, turn_kinds};

#[test]
fn child_links_to_the_parent_and_stores_only_its_own_turns() {
    let wrap = Wrap::seeded();
    let parent = wrap.run_with(&["how do I deploy"], vec![reply("you run deploy.sh")]);
    assert_eq!(parent.code, 0, "{}", parent.stderr);
    let child = wrap.run_with(&["-c", "ok do it"], vec![command("echo deploying", "low")]);
    assert_eq!(child.code, 0, "{}", child.stderr);
    assert_eq!(child.stdout, "deploying\n");

    let entries = wrap.log_entries();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1]["parent_id"], entries[0]["id"]);
    assert!(entries[0].get("parent_id").is_none() || entries[0]["parent_id"].is_null());
    assert_eq!(turn_kinds(&entries[1]), ["user", "assistant", "final"]);
}

#[test]
fn three_deep_chain_never_accumulates_turns() {
    let wrap = Wrap::seeded();
    wrap.run_with(&["how do I deploy"], vec![reply("deploy.sh")]);
    wrap.run_with(&["-c", "ok do it"], vec![command("echo go", "low")]);
    wrap.run_with(
        &["--continue", "what about staging"],
        vec![command("echo staging", "low")],
    );
    let entries = wrap.log_entries();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[1]["parent_id"], entries[0]["id"]);
    assert_eq!(entries[2]["parent_id"], entries[1]["id"]);
    let counts: Vec<usize> = entries.iter().map(|e| turn_kinds(e).len()).collect();
    assert_eq!(counts, [2, 3, 3]);
}

#[test]
fn the_ancestor_chain_is_reframed_with_the_child_context() {
    let wrap = Wrap::seeded();
    wrap.run_with(&["how do I deploy"], vec![reply("you run deploy.sh")]);
    let responses = serde_json::Value::Array(vec![command("echo deploying", "low")]).to_string();
    let child = wrap.run_full(
        &["-c", "ok do it"],
        &[
            ("WRAP_CONFIG", r#"{"logTraces":true}"#),
            ("WRAP_TEST_RESPONSES", &responses),
        ],
        None,
    );
    assert_eq!(child.code, 0, "{}", child.stderr);
    let entries = wrap.log_entries();
    let child_id = entries.last().unwrap()["id"].as_str().unwrap();
    let trace: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(wrap.home().join(format!("logs/traces/{child_id}.json"))).unwrap(),
    )
    .unwrap();
    let attempts = trace["turn_attempts"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    let messages = attempts[0]["request"]["messages"].as_array().unwrap();
    let user: Vec<&str> = messages
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["content"].as_str().unwrap())
        .collect();
    let framed: Vec<&&str> = user
        .iter()
        .filter(|c| c.contains("## User's request"))
        .collect();
    assert_eq!(framed.len(), 1);
    assert!(framed[0].contains("## User's request\nhow do I deploy"));
    assert!(user.contains(&"ok do it"));
    assert!(
        messages
            .iter()
            .filter(|m| m["role"] == "assistant")
            .any(|m| m["content"].as_str().unwrap().contains("you run deploy.sh"))
    );
}

#[test]
fn an_empty_log_refuses_before_calling_the_provider() {
    let out = Wrap::seeded().responses(vec![]).run(&["-c", "hi"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(out.stderr, "Continue error: no previous wrap run found.\n");
}

#[test]
fn a_parent_with_piped_input_cannot_be_continued() {
    let wrap = Wrap::seeded();
    let responses = serde_json::Value::Array(vec![reply("looks fine")]).to_string();
    let parent = wrap.run_full(
        &["explain this"],
        &[("WRAP_TEST_RESPONSES", &responses)],
        Some(b"some piped payload\n"),
    );
    assert_eq!(parent.code, 0, "{}", parent.stderr);
    let out = wrap.run_with(&["-c", "more"], vec![]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "Continue error: previous run had piped input that's no longer available.\n"
    );
    assert_eq!(wrap.log_entries().len(), 1, "the refusal appends nothing");
}

#[test]
fn a_missing_ancestor_truncates_the_chain_instead_of_failing() {
    let wrap = Wrap::seeded();
    let orphan = serde_json::json!({
        "id": "the-orphan", "timestamp": "2026-01-01T00:00:00.000Z", "version": "test",
        "cwd": "/tmp", "ppid": 999999, "parent_id": "missing-ancestor",
        "provider": { "name": "test", "model": "test" }, "prompt_hash": "h",
        "turns": [
            { "kind": "user", "text": "orphan prompt" },
            { "kind": "assistant", "attempts": [], "source": "model" }
        ],
        "outcome": "success"
    });
    std::fs::create_dir_all(wrap.home().join("logs")).unwrap();
    std::fs::write(wrap.home().join("logs/wrap.jsonl"), format!("{orphan}\n")).unwrap();
    let out = wrap.run_with(&["-c", "keep going"], vec![reply("ok")]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let entries = wrap.log_entries();
    assert_eq!(entries.last().unwrap()["parent_id"], "the-orphan");
}
