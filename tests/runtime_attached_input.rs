use std::cell::Cell;

use wrap::attached_input::{build_attached_input_preview, read_attached_input, truncate_middle};

#[test]
fn tty_stdin_is_never_read() {
    let called = Cell::new(false);
    let result = read_attached_input(true, || {
        called.set(true);
        Ok(b"should not be read".to_vec())
    });
    assert_eq!(result, None);
    assert!(!called.get());
}

#[test]
fn piped_bytes_are_returned_verbatim_including_non_utf8() {
    assert_eq!(
        read_attached_input(false, || Ok(b"hello world".to_vec())),
        Some(b"hello world".to_vec())
    );
    let bytes = vec![0xff, 0xfe, 0x41, 0x42];
    assert_eq!(
        read_attached_input(false, || Ok(bytes.clone())),
        Some(bytes)
    );
}

#[test]
fn empty_or_ascii_whitespace_only_input_is_dropped() {
    assert_eq!(read_attached_input(false, || Ok(Vec::new())), None);
    assert_eq!(
        read_attached_input(false, || Ok(b"   \n\t  \n  ".to_vec())),
        None
    );
    assert_eq!(
        read_attached_input(false, || Ok(vec![0x0b, 0x0c, 0x0d])),
        None
    );
}

#[test]
fn read_failure_counts_as_no_input() {
    let result = read_attached_input(false, || Err(std::io::Error::other("boom")));
    assert_eq!(result, None);
}

#[test]
fn preview_under_budget_is_returned_whole() {
    let result = build_attached_input_preview(b"hello world", 200);
    assert_eq!(result.preview, "hello world");
    assert!(!result.truncated);
    let exact = build_attached_input_preview(b"hello", 5);
    assert_eq!(exact.preview, "hello");
    assert!(!exact.truncated);
    let empty = build_attached_input_preview(b"", 200);
    assert_eq!(empty.preview, "");
    assert!(!empty.truncated);
}

#[test]
fn preview_over_budget_is_truncated_and_flagged() {
    let long = "x".repeat(500);
    let result = build_attached_input_preview(long.as_bytes(), 100);
    assert!(result.truncated);
    assert!(result.preview.chars().count() < 500);
}

#[test]
fn invalid_utf8_yields_a_binary_summary() {
    let bytes = [0xff, 0xfe, 0x00, 0xc0, 0xc1];
    let result = build_attached_input_preview(&bytes, 200);
    assert!(!result.truncated);
    assert_eq!(result.preview, "Binary content — 5 bytes, not previewable.");
}

#[test]
fn preview_keeps_multibyte_characters() {
    let result = build_attached_input_preview("héllo".as_bytes(), 200);
    assert_eq!(result.preview, "héllo");
    assert!(!result.truncated);
}

#[test]
fn truncate_middle_returns_input_within_limit() {
    assert_eq!(truncate_middle("short", 100), "short");
    let exact = "a".repeat(100);
    assert_eq!(truncate_middle(&exact, 100), exact);
}

#[test]
fn truncate_middle_keeps_head_and_tail_with_an_indicator() {
    let result = truncate_middle("abcdefghijklmnopqrstuvwxyz", 20);
    assert!(result.starts_with('a'));
    assert!(result.ends_with('z'));
    assert!(result.contains("…truncated"));
    assert!(result.contains("of 26 chars"));
}

#[test]
fn truncate_middle_output_stays_near_the_budget() {
    let result = truncate_middle(&"x".repeat(1000), 200);
    assert!(result.chars().count() < 300);
    assert!(result.contains("…truncated"));
}

#[test]
fn truncate_middle_splits_at_line_boundaries() {
    let lines: Vec<String> = (1..=100).map(|i| format!("line {i}")).collect();
    let result = truncate_middle(&lines.join("\n"), 200);
    assert!(result.contains("line 1\n"));
    assert!(result.contains("line 100"));
    assert!(result.contains("…truncated"));
}

#[test]
fn truncate_middle_indicator_reports_char_counts() {
    let result = truncate_middle(&"a".repeat(500), 100);
    assert!(result.contains("of 500 chars"));
    let re = regex::Regex::new(r"showing first \d+ and last \d+").unwrap();
    assert!(re.is_match(&result));
    assert!(result.starts_with('a'));
    assert!(result.ends_with('a'));
}

#[test]
fn truncate_middle_with_zero_budget_still_emits_the_indicator() {
    let result = truncate_middle("hello", 0);
    assert!(result.contains("…truncated"));
    assert!(result.ends_with("]\n"));
}

#[test]
fn truncate_middle_counts_characters_not_bytes() {
    let text = "é".repeat(100);
    let result = truncate_middle(&text, 50);
    assert!(result.contains("of 100 chars"));
}
