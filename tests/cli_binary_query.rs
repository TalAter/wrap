//! One-shot queries through the real binary with the canned test provider:
//! auto-execution, answers, the no-TTY block, config refusals, verbose
//! lines and first-run memory initialisation.

mod cli_binary_common;

use cli_binary_common::{Wrap, command, first_user_text, reply, step, turn_kinds};
use serde_json::json;

#[test]
fn low_risk_command_runs_with_its_stdout_and_exit_code_and_is_logged() {
    let wrap = Wrap::seeded().response(command("echo hi; exit 3", "low"));
    let out = wrap.run(&["say hi then fail"]);
    assert_eq!(out.code, 3);
    assert_eq!(out.stdout, "hi\n");
    // Only the shell's own startup noise may reach stderr, never chrome.
    assert!(!out.stderr.contains('»'), "{}", out.stderr);
    assert!(
        !out.stderr.contains("requires confirmation"),
        "{}",
        out.stderr
    );

    let entry = wrap.log_entry();
    assert_eq!(entry["outcome"], "error");
    assert_eq!(entry["input_source"], "argv");
    assert!(entry.get("attached_input").is_none());
    assert_eq!(turn_kinds(&entry), ["user", "assistant", "final"]);
    let last = entry["turns"].as_array().unwrap().last().unwrap();
    assert_eq!(last["command"], "echo hi; exit 3");
    assert_eq!(last["exit_code"], 3);
    assert_eq!(last["source"], "model");
}

#[test]
fn command_runs_in_an_interactive_shell_and_passes_stderr_through() {
    let out = Wrap::seeded()
        .response(command("echo \"$-\"; echo warning >&2", "low"))
        .run(&["check shell"]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.trim().contains('i'), "{}", out.stdout);
    assert!(out.stderr.contains("warning"));
}

#[test]
fn reply_goes_to_stdout_and_exits_0() {
    let wrap = Wrap::seeded().response(reply("42"));
    let out = wrap.run(&["what", "is", "6*7"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "42\n");
    assert_eq!(out.stderr, "");
    assert_eq!(first_user_text(&wrap.log_entry()), "what is 6*7");
}

#[test]
fn medium_risk_without_a_terminal_is_blocked_and_logged() {
    let wrap = Wrap::seeded().response(command("echo would-touch", "medium"));
    let out = wrap.run(&["touch it"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(
        out.stderr,
        "Command requires confirmation (no TTY available): echo would-touch\n"
    );
    let entry = wrap.log_entry();
    assert_eq!(entry["outcome"], "blocked");
    let last = entry["turns"].as_array().unwrap().last().unwrap();
    assert_eq!(last["kind"], "final");
    assert_eq!(last["source"], "blocked");
    assert_eq!(last["exit_code"], serde_json::Value::Null);
}

#[test]
fn yolo_auto_executes_medium_risk() {
    let via_flag = Wrap::seeded()
        .response(command("echo yolo-ran", "medium"))
        .run(&["--yolo", "go"]);
    assert_eq!(via_flag.code, 0, "{}", via_flag.stderr);
    assert_eq!(via_flag.stdout, "yolo-ran\n");
    let via_config = Wrap::seeded()
        .config(json!({ "yolo": true }))
        .response(command("echo yolo-ran", "high"))
        .run(&["go"]);
    assert_eq!(via_config.code, 0, "{}", via_config.stderr);
    assert_eq!(via_config.stdout, "yolo-ran\n");
}

#[test]
fn step_then_final_command_prints_only_the_final_output() {
    let out = Wrap::seeded()
        .responses(vec![
            step("echo found-sips", "Checking image tools"),
            command("echo converted", "low"),
        ])
        .run(&["convert"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "converted\n");
    assert!(
        out.stderr.contains("🔍 Checking image tools"),
        "{}",
        out.stderr
    );
}

#[test]
fn exhausted_round_budget_exits_1_with_a_rounds_message() {
    let out = Wrap::seeded()
        .config(json!({ "maxRounds": 2 }))
        .responses(vec![step("echo s1", "one"), step("echo s2", "two")])
        .run(&["check"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert!(out.stderr.contains("rounds"), "{}", out.stderr);
}

#[test]
fn provider_failure_is_a_clean_message() {
    let out = Wrap::seeded()
        .env("WRAP_TEST_RESPONSE", "ERROR:something went wrong")
        .run(&["hello"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert!(
        out.stderr.contains("something went wrong"),
        "{}",
        out.stderr
    );
    assert!(!out.stderr.contains("panicked"));
}

#[test]
fn no_llm_configured_is_a_config_error() {
    let out = Wrap::bare().config(json!({})).run(&["hello"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(
        out.stderr,
        "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.\n"
    );
}

#[test]
fn unknown_default_provider_and_model_override_are_config_errors() {
    let config = json!({
        "providers": { "anthropic": { "model": "haiku" } },
        "defaultProvider": "anthropic"
    });
    let via_flag = Wrap::bare()
        .config(config.clone())
        .run(&["--model", "openai", "hello"]);
    assert_eq!(via_flag.code, 1);
    assert_eq!(
        via_flag.stderr,
        "Config error: provider \"openai\" not found in config.\n"
    );
    let via_env = Wrap::bare()
        .config(config)
        .env("WRAP_MODEL", "openai")
        .run(&["hello"]);
    assert_eq!(via_env.code, 1);
    assert_eq!(
        via_env.stderr,
        "Config error: provider \"openai\" not found in config.\n"
    );
}

#[test]
fn malformed_wrap_config_is_a_config_error() {
    let out = Wrap::bare().env("WRAP_CONFIG", "{broken").run(&["hello"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(
        out.stderr,
        "Config error: WRAP_CONFIG contains invalid JSON.\n"
    );
}

#[test]
fn malformed_config_file_is_a_config_error() {
    let wrap = Wrap::bare();
    std::fs::write(wrap.home().join("config.jsonc"), "{ nope").unwrap();
    let out = wrap.run(&["hello"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "Config error: config.jsonc contains invalid JSON.\n"
    );
}

#[test]
fn missing_config_without_a_terminal_refuses_to_run_the_wizard() {
    let out = Wrap::bare().run(&["hello"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(
        out.stderr,
        "Config error: no config found. Run wrap in a terminal to set one up.\n"
    );
    assert!(!out.stdout.contains("Usage:"));
}

#[test]
fn verbose_narrates_startup_and_execution_on_stderr() {
    let out = Wrap::seeded()
        .response(command("echo hello", "low"))
        .run(&["--verbose", "list files"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "hello\n");
    for line in [
        "Config loaded",
        "Provider initialized (test / (default))",
        "Skill turns: ",
        "Memory: 1 facts",
        "Calling test / (default)...",
        "Running: echo hello",
        "Command exited (0)",
    ] {
        assert!(
            out.stderr.contains(line),
            "missing {line:?} in {}",
            out.stderr
        );
    }
    let stamped = out.stderr.lines().filter(|l| l.contains('»')).count();
    assert!(stamped >= 7, "{}", out.stderr);
    let timer = regex::Regex::new(r"\[\+\d+\.\d{2}s\]").unwrap();
    for line in out.stderr.lines().filter(|l| l.contains('»')) {
        assert!(timer.is_match(line), "{line}");
    }
}

#[test]
fn verbose_from_config_and_quiet_without_it() {
    let quiet = Wrap::seeded().response(reply("world")).run(&["hello"]);
    assert!(!quiet.stderr.contains('»'));

    let configured = Wrap::seeded()
        .config(json!({ "verbose": true }))
        .response(reply("world"))
        .run(&["hello"]);
    assert!(
        configured.stderr.contains("Config loaded"),
        "{}",
        configured.stderr
    );
    assert_eq!(configured.stdout, "world\n");
}

#[test]
fn first_run_initialises_memory_from_the_shared_playback_cursor() {
    let wrap = Wrap::bare().config(json!({})).responses(vec![
        json!({ "facts": ["Runs Linux on x86_64"] }),
        command("echo hi", "low"),
    ]);
    let out = wrap.run(&["--verbose", "say hi"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "hi\n");
    assert!(
        out.stderr.contains("Learning about your system"),
        "{}",
        out.stderr
    );
    assert!(out.stderr.contains("Init: probing OS and shell..."));
    let memory: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(wrap.home().join("memory.json")).unwrap())
            .unwrap();
    assert_eq!(memory["/"][0]["fact"], "Runs Linux on x86_64");
}

#[test]
fn memory_updates_from_a_response_persist_and_are_announced() {
    let wrap = Wrap::seeded().response(json!({
        "type": "command", "content": "echo hi", "risk_level": "low",
        "memory_updates": [{ "fact": "Uses zsh", "scope": "/" }],
        "memory_updates_message": "Noted: you use zsh"
    }));
    let out = wrap.run(&["list files"]);
    assert_eq!(out.code, 0);
    assert!(
        out.stderr.contains("🧠 Noted: you use zsh"),
        "{}",
        out.stderr
    );
    let memory = std::fs::read_to_string(wrap.home().join("memory.json")).unwrap();
    assert!(memory.contains("Uses zsh"));
}

#[test]
fn eval_bridge_flag_answers_from_stdin_json() {
    let out = Wrap::bare()
        .stdin(
            json!({
                "mode": "assemble", "instruction": "You are a CLI tool.", "fewShotExamples": [],
                "schemaText": "z.object({ type: z.string() })", "memory": {},
                "cwd": "/tmp", "piped": false, "query": "list files"
            })
            .to_string(),
        )
        .run(&["--eval-bridge"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let result: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    assert!(result["promptInput"]["system"].is_string());
}
