use std::fs;

use wrap::home::WrapHome;
use wrap::watchlist::{WatchlistEntry, add_to_watchlist, is_valid_tool_name, load_watchlist};

fn home() -> (tempfile::TempDir, WrapHome) {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    (dir, home)
}

fn entry(tool: &str, added: &str) -> WatchlistEntry {
    WatchlistEntry {
        tool: tool.to_string(),
        added: added.to_string(),
    }
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

#[test]
fn missing_or_empty_file_loads_as_empty() {
    let (_dir, home) = home();
    assert_eq!(load_watchlist(&home), vec![]);
    home.write("tool-watchlist.json", "").unwrap();
    assert_eq!(load_watchlist(&home), vec![]);
}

#[test]
fn valid_entries_load_in_file_order() {
    let (_dir, home) = home();
    home.write(
        "tool-watchlist.json",
        r#"[{"tool":"sips","added":"2026-03-21"},{"tool":"convert","added":"2026-03-21"}]"#,
    )
    .unwrap();
    assert_eq!(
        load_watchlist(&home),
        vec![entry("sips", "2026-03-21"), entry("convert", "2026-03-21")]
    );
}

#[test]
fn malformed_entries_and_invalid_names_are_filtered_out() {
    let (_dir, home) = home();
    home.write(
        "tool-watchlist.json",
        r#"[null,"string-entry",42,{"tool":42,"added":"2026-04-23"},{"tool":"git","added":20260423},{"tool":"git","added":"2026-04-23"},{"tool":"rm -rf /","added":"2026-04-23"},{"tool":"; rm -rf /","added":"2026-04-23"}]"#,
    )
    .unwrap();
    assert_eq!(load_watchlist(&home), vec![entry("git", "2026-04-23")]);
}

#[test]
fn malformed_json_or_non_array_loads_as_empty() {
    let (_dir, home) = home();
    home.write("tool-watchlist.json", "not json{{{").unwrap();
    assert_eq!(load_watchlist(&home), vec![]);
    home.write("tool-watchlist.json", r#"{"tool":"sips"}"#)
        .unwrap();
    assert_eq!(load_watchlist(&home), vec![]);
}

#[test]
fn adding_creates_the_file_with_dated_entries_in_order() {
    let (_dir, home) = home();
    add_to_watchlist(&home, &["sips".into(), "convert".into()]).unwrap();
    let loaded = load_watchlist(&home);
    assert_eq!(
        loaded,
        vec![entry("sips", &today()), entry("convert", &today())]
    );
    let raw = fs::read_to_string(home.resolve("tool-watchlist.json")).unwrap();
    assert!(
        raw.ends_with("]\n"),
        "pretty JSON with trailing newline: {raw:?}"
    );
    assert!(raw.contains("\n  {\n    \"tool\": \"sips\""), "{raw}");
}

#[test]
fn renomination_updates_the_date_and_keeps_position() {
    let (_dir, home) = home();
    home.write(
        "tool-watchlist.json",
        r#"[{"tool":"sips","added":"2025-01-01"},{"tool":"other","added":"2025-01-01"}]"#,
    )
    .unwrap();
    add_to_watchlist(&home, &["sips".into(), "convert".into()]).unwrap();
    assert_eq!(
        load_watchlist(&home),
        vec![
            entry("sips", &today()),
            entry("other", "2025-01-01"),
            entry("convert", &today())
        ]
    );
}

#[test]
fn invalid_names_are_dropped_and_an_all_invalid_batch_is_a_no_op() {
    let (_dir, home) = home();
    add_to_watchlist(&home, &[]).unwrap();
    add_to_watchlist(&home, &["; rm -rf /".into(), "$(whoami)".into(), "".into()]).unwrap();
    assert!(!home.exists("tool-watchlist.json"));
    add_to_watchlist(&home, &["valid-tool".into(), "; rm -rf /".into()]).unwrap();
    assert_eq!(load_watchlist(&home), vec![entry("valid-tool", &today())]);
}

#[test]
fn tool_name_validation_rejects_shell_metacharacters() {
    assert!(is_valid_tool_name("clip.exe"));
    assert!(is_valid_tool_name("wl-copy"));
    assert!(is_valid_tool_name("python3"));
    assert!(!is_valid_tool_name(""));
    assert!(!is_valid_tool_name("-flag"));
    assert!(!is_valid_tool_name(".hidden"));
    assert!(!is_valid_tool_name("a b"));
    assert!(!is_valid_tool_name("$(whoami)"));
}
