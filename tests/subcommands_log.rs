use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value, json};
use wrap::chrome::{self, Notification};
use wrap::cli::Modifiers;
use wrap::config::{Config, ResolvedConfig, resolve_settings};
use wrap::home::WrapHome;
use wrap::subcommands::log::{OutputMode, output_mode, parse_log_args, read_log, search_entries};
use wrap::subcommands::{Bucket, Context, Footprints, log};

static CHROME_LOCK: Mutex<()> = Mutex::new(());

fn capture_chrome(f: impl FnOnce() -> i32) -> (i32, Vec<String>) {
    let _serial = CHROME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let guard = chrome::subscribe(tx);
    let code = f();
    drop(guard);
    let mut lines = Vec::new();
    while let Ok(n) = rx.try_recv() {
        if let Notification::Chrome { text, .. } = n {
            lines.push(text);
        }
    }
    (code, lines)
}

fn config(env: &HashMap<String, String>) -> ResolvedConfig {
    resolve_settings(&Modifiers::default(), env, &Config::default()).unwrap()
}

fn no_dialog(_: &Footprints) -> Option<Vec<Bucket>> {
    None
}

fn never_which(_: &str) -> bool {
    false
}

fn entry(id: &str, prompt: &str) -> String {
    json!({"id": id, "timestamp": "2026-03-23T00:00:00Z", "prompt": prompt}).to_string()
}

fn seed(home: &WrapHome, lines: &[String]) {
    let mut content = lines.join("\n");
    if !lines.is_empty() {
        content.push('\n');
    }
    home.write("logs/wrap.jsonl", &content).unwrap();
}

fn run_log(home: &WrapHome, args: &[&str], tty: bool) -> (i32, Vec<String>, String) {
    let env = HashMap::new();
    let config = config(&env);
    let ctx = Context {
        home,
        env: &env,
        config: &config,
        stdout_is_tty: tty,
        stdin_is_tty: false,
        terminal_rows: None,
        which: &never_which,
        forget_dialog: &no_dialog,
    };
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut out = Vec::new();
    let (code, chrome) = capture_chrome(|| log::run(&args, &ctx, &mut out));
    (code, chrome, String::from_utf8(out).unwrap())
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| a.to_string()).collect()
}

// ── parse_log_args ───────────────────────────────────────────────

#[test]
fn parses_count_search_and_raw_in_any_order() {
    let parsed = parse_log_args(&args(&["find", "2", "--raw"])).unwrap();
    assert_eq!(parsed.n, Some(2));
    assert_eq!(parsed.search.as_deref(), Some("find"));
    assert!(parsed.raw);
    let parsed = parse_log_args(&args(&["--raw", "0"])).unwrap();
    assert_eq!(parsed.n, Some(0));
    assert_eq!(parsed.search, None);
    let parsed = parse_log_args(&args(&[])).unwrap();
    assert_eq!((parsed.n, parsed.search, parsed.raw), (None, None, false));
}

#[test]
fn numeric_lookalikes_are_search_terms() {
    assert_eq!(
        parse_log_args(&args(&["3abc"])).unwrap().search.as_deref(),
        Some("3abc")
    );
    assert_eq!(
        parse_log_args(&args(&["007"])).unwrap().search.as_deref(),
        Some("007")
    );
    assert_eq!(
        parse_log_args(&args(&["+5"])).unwrap().search.as_deref(),
        Some("+5")
    );
    assert_eq!(
        parse_log_args(&args(&["1.5"])).unwrap().search.as_deref(),
        Some("1.5")
    );
}

#[test]
fn empty_string_argument_is_ignored() {
    let parsed = parse_log_args(&args(&["", "term"])).unwrap();
    assert_eq!(parsed.search.as_deref(), Some("term"));
}

#[test]
fn negative_count_and_second_term_are_errors_with_usage() {
    let usage = "Usage: w --log [search] [N] [--raw]";
    for bad in ["-3", "-30"] {
        let err = parse_log_args(&args(&[bad])).unwrap_err();
        assert_eq!(
            err,
            ["Invalid argument: N must be a non-negative integer.", usage]
        );
    }
    let err = parse_log_args(&args(&["foo", "bar"])).unwrap_err();
    assert_eq!(err, ["Only one search term allowed.", usage]);
}

// ── read_log / search ────────────────────────────────────────────

#[test]
fn read_log_handles_missing_and_empty_files() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let read = read_log(&home, None);
    assert!(read.valid.is_empty());
    assert_eq!(read.corrupt, 0);
    seed(&home, &[]);
    let read = read_log(&home, None);
    assert!(read.valid.is_empty());
    assert_eq!(read.corrupt, 0);
}

#[test]
fn read_log_slices_last_n_raw_lines_counting_corrupt_ones() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    seed(
        &home,
        &[
            entry("a", "x"),
            entry("b", "x"),
            entry("c", "x"),
            "bad".into(),
            entry("e", "x"),
        ],
    );
    let read = read_log(&home, Some(3));
    let ids: Vec<&str> = read
        .valid
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["c", "e"]);
    assert_eq!(read.corrupt, 1);
    let all = read_log(&home, None);
    assert_eq!(all.valid.len(), 4);
    assert_eq!(all.corrupt, 1);
}

#[test]
fn search_is_case_insensitive_over_nested_json() {
    let entries = vec![
        json!({"id": "a", "nested": {"command": "Docker PS"}}),
        json!({"id": "b", "prompt": "list stuff"}),
    ];
    let hits = search_entries(&entries, "docker");
    assert_eq!(hits, vec![entries[0].clone()]);
    assert!(search_entries(&entries, "zzz").is_empty());
    assert_eq!(search_entries(&entries, "id").len(), 2);
}

// ── output mode ──────────────────────────────────────────────────

#[test]
fn output_mode_prefers_raw_then_jq_then_pretty() {
    assert_eq!(output_mode(true, true, true), OutputMode::Raw);
    assert_eq!(output_mode(false, false, true), OutputMode::Raw);
    assert_eq!(output_mode(false, true, true), OutputMode::Jq);
    assert_eq!(output_mode(false, true, false), OutputMode::Pretty);
}

// ── run ──────────────────────────────────────────────────────────

#[test]
fn piped_output_is_raw_jsonl_of_all_entries() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let lines = vec![entry("a", "t"), entry("b", "t"), entry("c", "t")];
    seed(&home, &lines);
    let (code, chrome, out) = run_log(&home, &[], false);
    assert_eq!(code, 0);
    assert!(chrome.is_empty());
    assert_eq!(out, format!("{}\n", lines.join("\n")));
}

#[test]
fn last_n_entries_and_zero_prints_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    seed(&home, &[entry("a", "t"), entry("b", "t"), entry("c", "t")]);
    let (code, _, out) = run_log(&home, &["2"], false);
    assert_eq!(code, 0);
    assert_eq!(out, format!("{}\n{}\n", entry("b", "t"), entry("c", "t")));
    let (code, chrome, out) = run_log(&home, &["0"], false);
    assert_eq!(code, 0);
    assert_eq!(out, "");
    assert!(chrome.is_empty());
}

#[test]
fn no_entries_message_goes_to_stderr_with_exit_0() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let (code, chrome, out) = run_log(&home, &[], false);
    assert_eq!(code, 0);
    assert_eq!(out, "");
    assert_eq!(chrome, ["No log entries yet."]);
    seed(&home, &[]);
    let (_, chrome, _) = run_log(&home, &[], false);
    assert_eq!(chrome, ["No log entries yet."]);
}

#[test]
fn corrupt_lines_are_skipped_with_a_counted_warning() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    seed(
        &home,
        &[entry("a", "t"), "not-json".into(), entry("c", "t")],
    );
    let (code, chrome, out) = run_log(&home, &[], false);
    assert_eq!(code, 0);
    assert_eq!(out, format!("{}\n{}\n", entry("a", "t"), entry("c", "t")));
    assert_eq!(chrome, ["Warning: skipped 1 corrupt log entry"]);
    seed(&home, &[entry("a", "t"), "x".into(), "y".into()]);
    let (_, chrome, _) = run_log(&home, &[], false);
    assert_eq!(chrome, ["Warning: skipped 2 corrupt log entries"]);
}

#[test]
fn only_corrupt_lines_prints_nothing_but_still_warns() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    seed(&home, &["bad".into()]);
    let (code, chrome, out) = run_log(&home, &[], false);
    assert_eq!(code, 0);
    assert_eq!(out, "");
    assert_eq!(chrome, ["No log entries yet."]);
}

#[test]
fn search_filters_then_takes_last_n_matches() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    seed(
        &home,
        &[
            entry("a", "find one"),
            entry("b", "list docker"),
            entry("c", "Find two"),
            entry("d", "find three"),
        ],
    );
    let (code, _, out) = run_log(&home, &["find"], false);
    assert_eq!(code, 0);
    assert!(out.contains("find one") && out.contains("Find two") && out.contains("find three"));
    assert!(!out.contains("list docker"));
    let (_, _, out) = run_log(&home, &["find", "2"], false);
    assert!(!out.contains("find one"));
    assert!(out.contains("Find two") && out.contains("find three"));
    let (code, chrome, out) = run_log(&home, &["zzzzz"], false);
    assert_eq!(code, 0);
    assert_eq!(out, "");
    assert_eq!(chrome, ["No matching log entries."]);
    let (_, chrome, out) = run_log(&home, &["3abc"], false);
    assert_eq!(out, "");
    assert_eq!(chrome, ["No matching log entries."]);
}

#[test]
fn argument_errors_exit_1_and_print_usage() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let (code, chrome, out) = run_log(&home, &["foo", "bar"], false);
    assert_eq!(code, 1);
    assert_eq!(out, "");
    assert_eq!(chrome[0], "Only one search term allowed.");
    let (code, chrome, _) = run_log(&home, &["-3"], false);
    assert_eq!(code, 1);
    assert!(chrome[0].contains("non-negative integer"));
}

#[test]
fn tty_without_jq_pretty_prints_entries_separated_by_blank_lines() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    seed(&home, &[entry("a", "t"), entry("b", "t")]);
    let (code, _, out) = run_log(&home, &[], true);
    assert_eq!(code, 0);
    let a: Value = serde_json::from_str(&entry("a", "t")).unwrap();
    let b: Value = serde_json::from_str(&entry("b", "t")).unwrap();
    let expected = format!(
        "{}\n\n{}\n",
        serde_json::to_string_pretty(&a).unwrap(),
        serde_json::to_string_pretty(&b).unwrap()
    );
    assert_eq!(out, expected);
    assert!(out.contains("\n  \"id\": \"a\""));
    let (_, _, raw) = run_log(&home, &["--raw"], true);
    assert_eq!(raw, format!("{}\n{}\n", entry("a", "t"), entry("b", "t")));
}
