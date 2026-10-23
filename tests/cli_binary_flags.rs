//! Subcommand flags through the real binary: payload on stdout, chrome on
//! stderr, and the no-input fallback to help.

mod cli_binary_common;

use cli_binary_common::Wrap;

#[test]
fn version_prints_the_crate_version_and_nothing_else() {
    for flag in ["--version", "-v"] {
        let out = Wrap::bare().run(&[flag]);
        assert_eq!(out.code, 0, "{flag}");
        assert_eq!(out.stdout, format!("{}\n", env!("CARGO_PKG_VERSION")));
        // No themed chrome and no OSC background probe bytes.
        assert_eq!(out.stderr, "", "{flag}");
    }
}

#[test]
fn version_rejects_an_argument() {
    let out = Wrap::bare().run(&["--version", "extra"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert!(
        out.stderr.contains("does not take an argument"),
        "{}",
        out.stderr
    );
}

#[test]
fn help_is_plain_text_when_stdout_is_a_pipe() {
    let out = Wrap::bare().run(&["--help"]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains("Usage:"), "{}", out.stdout);
    assert!(!out.stdout.contains("\x1b["), "plain output on a pipe");
    assert_eq!(out.stderr, "");
}

#[test]
fn unknown_flag_is_reported_on_stderr_and_exits_1() {
    let out = Wrap::bare().run(&["--nope"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(out.stderr, "Unknown flag: --nope\n");
}

#[test]
fn no_args_without_a_terminal_shows_help() {
    let out = Wrap::bare().run(&[]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains("Usage:"), "{}", out.stdout);
    assert_eq!(out.stderr, "");
}

#[test]
fn empty_or_whitespace_pipe_counts_as_no_input_and_shows_help() {
    for payload in ["", "   \n\t  "] {
        let out = Wrap::bare().stdin(payload).run(&[]);
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("Usage:"), "{payload:?}");
    }
}

#[test]
fn a_modifier_alone_still_falls_back_to_help_without_config_chrome() {
    let out = Wrap::bare().run(&["--verbose"]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains("Usage:"));
    assert!(!out.stderr.contains("Config loaded"));
}

#[test]
fn modifier_errors_surface_as_config_errors() {
    let out = Wrap::bare().run(&["--verbose=1", "hello"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert_eq!(
        out.stderr,
        "Config error: --verbose does not take a value.\n"
    );
}

#[test]
fn log_raw_prints_the_appended_entry() {
    let wrap = Wrap::seeded().response(cli_binary_common::reply("ok"));
    assert_eq!(wrap.run(&["say ok"]).code, 0);
    let out = wrap.run(&["--log", "--raw"]);
    assert_eq!(out.code, 0);
    let entry: serde_json::Value = serde_json::from_str(out.stdout.trim()).unwrap();
    assert_eq!(entry["outcome"], "success");
    assert_eq!(cli_binary_common::first_user_text(&entry), "say ok");
}

#[test]
fn log_with_no_entries_narrates_on_stderr_only() {
    let out = Wrap::bare().run(&["--log"]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "");
    assert_eq!(out.stderr, "No log entries yet.\n");
}

#[test]
fn forget_with_yolo_deletes_persisted_data_without_a_dialog() {
    let wrap = Wrap::seeded().response(cli_binary_common::reply("ok"));
    assert_eq!(wrap.run(&["remember me"]).code, 0);
    assert!(wrap.home().join("memory.json").exists());
    assert!(wrap.home().join("logs/wrap.jsonl").exists());

    let out = wrap.run(&["--forget", "--yolo"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "");
    assert!(out.stderr.contains("Forgotten."), "{}", out.stderr);
    assert!(!wrap.home().join("memory.json").exists());
    assert!(!wrap.home().join("logs/wrap.jsonl").exists());
}

#[test]
fn forget_without_a_terminal_or_yolo_refuses() {
    let out = Wrap::seeded().run(&["--forget"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "");
    assert!(out.stderr.contains("Forget error:"), "{}", out.stderr);
}
