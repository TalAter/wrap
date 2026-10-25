use std::collections::HashMap;

use wrap::ansi::strip_ansi;
use wrap::cli::Modifiers;
use wrap::config::{Config, ResolvedConfig, resolve_settings};
use wrap::home::WrapHome;
use wrap::subcommands::help::{
    animation_fits, build_diff_escape, render_flag_help, render_plain, render_styled,
};
use wrap::subcommands::{Bucket, CliFlag, CompletionKind, Context, FlagKind, Footprints, help};

fn cmd(flag: &str, description: &str, usage: &str, help: Option<&str>) -> CliFlag {
    CliFlag {
        flag: flag.to_string(),
        aliases: vec![],
        id: flag.trim_start_matches('-').to_string(),
        description: description.to_string(),
        usage: usage.to_string(),
        help: help.map(str::to_string),
        completion: None::<CompletionKind>,
        kind: FlagKind::Command,
    }
}

fn opt(flag: &str, description: &str, usage: &str, takes_value: bool, env: &[&str]) -> CliFlag {
    CliFlag {
        flag: flag.to_string(),
        aliases: vec![],
        id: flag.trim_start_matches('-').to_string(),
        description: description.to_string(),
        usage: usage.to_string(),
        help: None,
        completion: None,
        kind: FlagKind::Option {
            takes_value,
            env: env.iter().map(|e| e.to_string()).collect(),
        },
    }
}

fn test_cmds() -> Vec<CliFlag> {
    vec![
        cmd("--foo", "Do foo", "w --foo", None),
        cmd("--bar", "Do bar", "w --bar [n]", None),
    ]
}

fn test_opts() -> Vec<CliFlag> {
    vec![opt("--baz", "Do baz", "w --baz <val>", true, &[])]
}

fn rows(cells: &[&[&str]]) -> Vec<Vec<String>> {
    cells
        .iter()
        .map(|row| row.iter().map(|c| c.to_string()).collect())
        .collect()
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn config(env: &HashMap<String, String>, flags: &[&str]) -> ResolvedConfig {
    let modifiers = Modifiers {
        flags: flags.iter().map(|f| f.to_string()).collect(),
        ..Modifiers::default()
    };
    resolve_settings(&modifiers, env, &Config::default()).unwrap()
}

fn no_dialog(_: &Footprints) -> Option<Vec<Bucket>> {
    None
}

fn never_which(_: &str) -> bool {
    false
}

fn run_help(
    args: &[&str],
    env: &HashMap<String, String>,
    flags: &[&str],
    tty: bool,
) -> (i32, String) {
    let home = WrapHome::new("/nonexistent/wrap-home");
    let config = config(env, flags);
    let ctx = Context {
        tmp_base: home.root().join("tmp"),
        home: &home,
        env,
        config: &config,
        stdout_is_tty: tty,
        stdin_is_tty: false,
        terminal_rows: Some(50),
        which: &never_which,
        forget_dialog: &no_dialog,
    };
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut out = Vec::new();
    let code = help::run(&args, &ctx, &mut out);
    (code, String::from_utf8(out).unwrap())
}

// ── render_plain ─────────────────────────────────────────────────

#[test]
fn plain_has_no_escapes_and_lists_flags_with_usage_hints() {
    let text = render_plain(&test_cmds(), &test_opts());
    assert!(!text.contains("\x1b["));
    assert!(text.contains("  --foo"));
    assert!(text.contains("  --bar [n]"));
    assert!(text.contains("  --baz <val>"));
    assert!(text.contains("Do foo"));
    assert!(text.contains("Do baz"));
}

#[test]
fn plain_has_usage_examples_and_section_headers() {
    let text = render_plain(&test_cmds(), &test_opts());
    assert!(text.starts_with("wrap - natural language shell commands\n\nUsage: w <prompt>"));
    assert!(text.contains("Examples:\n  wrap copy the contents of my .env file to clipboard, mask any IP addresses\n      wrap writes the shell command for your request and runs it after\n      you confirm\n  wrap\n      launch interactive mode — compose a multiline prompt in a friendly\n      editor\n"));
    assert!(text.contains("\nCommands:\n"));
    assert!(text.contains("\nOptions:\n"));
    assert!(text.ends_with('\n'));
}

#[test]
fn plain_pads_flag_column_to_24_with_at_least_one_space() {
    let long = cmd(
        "--a-very-long-flag-name-here",
        "Desc",
        "w --a-very-long-flag-name-here",
        None,
    );
    let text = render_plain(&[long], &[]);
    assert!(text.contains("  --a-very-long-flag-name-here Desc"));
    let short = render_plain(&test_cmds(), &[]);
    assert!(short.contains(&format!("  --foo{}Do foo", " ".repeat(24 - 7))));
}

// ── render_styled ────────────────────────────────────────────────

#[test]
fn styled_uses_escapes_matching_the_color_level() {
    let l3 = render_styled(&test_cmds(), &test_opts(), 3);
    assert!(l3.contains("\x1b[38;2;"));
    let l2 = render_styled(&test_cmds(), &test_opts(), 2);
    assert!(l2.contains("\x1b[38;5;"));
    assert!(!l2.contains("\x1b[38;2;"));
    let l1 = render_styled(&test_cmds(), &test_opts(), 1);
    assert!(!l1.contains("\x1b[38;2;"));
    assert!(!l1.contains("\x1b[38;5;"));
    let basic = regex::Regex::new("\x1b\\[3[0-7]m|\x1b\\[9[0-7]m").unwrap();
    assert!(basic.is_match(&l1));
}

#[test]
fn styled_contains_logo_bar_tagline_and_bold_headers() {
    let styled = render_styled(&test_cmds(), &test_opts(), 3);
    let plain = strip_ansi(&styled);
    assert!(plain.contains("█"));
    assert!(plain.contains(&format!("  {}", "─".repeat(34))));
    assert!(styled.contains("  \x1b[2mnatural language shell commands\x1b[0m"));
    assert!(styled.contains("  \x1b[1mUsage:\x1b[0m w <prompt>"));
    assert!(styled.contains("  \x1b[1mExamples:\x1b[0m"));
    assert!(styled.contains("  \x1b[1mCommands:\x1b[0m"));
    assert!(styled.contains("  \x1b[1mOptions:\x1b[0m"));
    assert!(plain.contains("    wrap copy the contents of my .env file to clipboard, mask any IP addresses\n        wrap writes the shell command for your request and runs it after\n        you confirm\n    wrap\n        launch interactive mode — compose a multiline prompt in a friendly\n        editor\n"));
    assert!(styled.starts_with('\n'));
    assert!(styled.ends_with("\n\n"));
}

#[test]
fn styled_flag_lines_match_plain_when_stripped() {
    let plain = render_plain(&test_cmds(), &test_opts());
    let styled = strip_ansi(&render_styled(&test_cmds(), &test_opts(), 3));
    let flag_lines: Vec<&str> = plain.lines().filter(|l| l.starts_with("  --")).collect();
    assert_eq!(flag_lines.len(), 3);
    for line in flag_lines {
        assert!(styled.contains(line), "missing {line:?}");
    }
}

#[test]
fn styled_colors_the_flag_column_only() {
    let styled = render_styled(&test_cmds(), &test_opts(), 3);
    let line = styled
        .lines()
        .find(|l| strip_ansi(l).starts_with("  --foo"))
        .unwrap();
    assert!(line.starts_with("\x1b[38;2;"));
    assert!(line.contains("  --foo\x1b[0m"));
    assert!(line.ends_with("Do foo"));
}

// ── render_flag_help ─────────────────────────────────────────────

#[test]
fn flag_help_is_usage_blank_description() {
    let text = render_flag_help(&cmd("--foo", "Do foo", "w --foo [bar]", None));
    assert_eq!(text, "w --foo [bar]\n\n  Do foo\n");
}

#[test]
fn flag_help_appends_help_text_and_env_line() {
    let text = render_flag_help(&cmd(
        "--foo",
        "Do foo",
        "w --foo",
        Some("Extra details here."),
    ));
    assert_eq!(text, "w --foo\n\n  Do foo\n\nExtra details here.\n");
    let with_env = render_flag_help(&opt(
        "--baz",
        "Do baz",
        "w --baz",
        false,
        &["WRAP_BAZ", "WRAP_BAZ_LEGACY"],
    ));
    assert_eq!(
        with_env,
        "w --baz\n\n  Do baz\n\n  Env: WRAP_BAZ, WRAP_BAZ_LEGACY\n"
    );
    let no_env = render_flag_help(&opt("--baz", "Do baz", "w --baz", false, &[]));
    assert!(!no_env.to_lowercase().contains("env"));
}

// ── build_diff_escape ────────────────────────────────────────────

#[test]
fn identical_frames_emit_only_carriage_return() {
    let frame = rows(&[&["a", "b", "c"]]);
    assert_eq!(build_diff_escape(Some(&frame), &frame), "\r");
}

#[test]
fn no_baseline_paints_every_cell_and_returns_to_origin() {
    let curr = rows(&[&["a", "b"], &["c", "d"]]);
    let out = build_diff_escape(None, &curr);
    assert_eq!(out, "\rab\x1b[0m\x1b[1B\rcd\x1b[0m\x1b[1A\r");
}

#[test]
fn only_dirty_range_is_painted_with_a_column_move() {
    let prev = rows(&[&["x", "x", "x", "x", "x"]]);
    let curr = rows(&[&["x", "x", "Y", "x", "x"]]);
    assert_eq!(build_diff_escape(Some(&prev), &curr), "\r\x1b[2CY\x1b[0m\r");
}

#[test]
fn unchanged_rows_are_skipped_without_cursor_motion() {
    let prev = rows(&[&["a", "b"], &["c", "d"], &["e", "f"]]);
    let curr = rows(&[&["a", "b"], &["c", "X"], &["e", "f"]]);
    assert_eq!(
        build_diff_escape(Some(&prev), &curr),
        "\x1b[1B\r\x1b[1CX\x1b[0m\x1b[1A\r"
    );
}

// ── animation_fits ───────────────────────────────────────────────

#[test]
fn animation_fits_when_content_is_within_known_rows() {
    assert!(animation_fits(20, Some(40)));
    assert!(animation_fits(40, Some(40)));
    assert!(!animation_fits(41, Some(40)));
    assert!(animation_fits(100, None));
    assert!(animation_fits(100, Some(0)));
}

// ── run ──────────────────────────────────────────────────────────

#[test]
fn help_without_tty_or_color_hints_is_plain() {
    let (code, out) = run_help(&[], &env(&[]), &[], false);
    assert_eq!(code, 0);
    assert!(!out.contains("\x1b["));
    assert!(out.contains("Usage:"));
    assert!(out.contains("--log"));
    assert!(out.contains("--help"));
    assert!(out.contains("--version"));
    assert!(out.contains("--model"));
    assert!(out.contains("--verbose"));
    assert!(!out.contains("--log-pretty"));
}

#[test]
fn no_color_forces_plain_even_on_a_tty() {
    let (code, out) = run_help(&[], &env(&[("NO_COLOR", "1")]), &[], true);
    assert_eq!(code, 0);
    assert!(!out.contains("\x1b["));
    assert!(out.contains("Usage:"));
}

#[test]
fn force_color_without_tty_renders_styled_without_animation() {
    let (code, out) = run_help(&[], &env(&[("FORCE_COLOR", "3")]), &[], false);
    assert_eq!(code, 0);
    assert!(out.contains("\x1b[38;2;"));
    assert!(
        !out.contains("\x1b[A"),
        "no cursor-up: animation must not run off a TTY"
    );
    assert!(!out.contains("A\x1b["));
    assert!(out.contains("Show this help"));
    assert!(out.contains("Show version"));
}

#[test]
fn no_animation_on_a_truecolor_tty_prints_styled_once() {
    let (code, out) = run_help(
        &[],
        &env(&[("COLORTERM", "truecolor")]),
        &["noAnimation"],
        true,
    );
    assert_eq!(code, 0);
    assert!(out.contains("\x1b[38;2;"));
    assert_eq!(out.matches("natural language shell commands").count(), 1);
    assert!(!out.contains("\x1b[1B"));
}

#[test]
fn animated_help_writes_styled_text_then_frames_and_lands_below() {
    let (code, out) = run_help(&[], &env(&[("COLORTERM", "truecolor")]), &[], true);
    assert_eq!(code, 0);
    let styled = render_styled(
        &wrap::subcommands::commands(),
        &wrap::subcommands::options(),
        3,
    );
    assert!(out.starts_with(&styled));
    let up = styled.matches('\n').count() - 1;
    let rest = &out[styled.len()..];
    assert!(rest.starts_with(&format!("\x1b[{up}A")));
    assert!(rest.ends_with(&format!("\x1b[{up}B")));
    // Every frame repaints the bottom bar (row 7) last, then climbs back to row 0.
    assert!(rest.contains("\x1b[0m\x1b[7A\r"));
    assert!(rest.contains("\x1b[1B\r"));
}

#[test]
fn animation_skipped_when_help_is_taller_than_the_terminal() {
    let home = WrapHome::new("/nonexistent/wrap-home");
    let env = env(&[("COLORTERM", "truecolor")]);
    let config = config(&env, &[]);
    let ctx = Context {
        tmp_base: home.root().join("tmp"),
        home: &home,
        env: &env,
        config: &config,
        stdout_is_tty: true,
        stdin_is_tty: false,
        terminal_rows: Some(5),
        which: &never_which,
        forget_dialog: &no_dialog,
    };
    let mut out = Vec::new();
    assert_eq!(help::run(&[], &ctx, &mut out), 0);
    let out = String::from_utf8(out).unwrap();
    let styled = render_styled(
        &wrap::subcommands::commands(),
        &wrap::subcommands::options(),
        3,
    );
    assert_eq!(out, styled);
}

#[test]
fn help_for_a_named_flag_with_or_without_dashes() {
    let (code, out) = run_help(&["--log"], &env(&[]), &[], false);
    assert_eq!(code, 0);
    assert!(out.starts_with("w --log [search] [N] [--raw]\n\n  Show log entries\n"));
    let (code, out) = run_help(&["log"], &env(&[]), &[], false);
    assert_eq!(code, 0);
    assert!(out.contains("--log"));
    let (code, out) = run_help(&["--model"], &env(&[]), &[], false);
    assert_eq!(code, 0);
    assert!(out.contains("Override LLM provider/model"));
    assert!(out.contains("Env: WRAP_MODEL"));
    let (code, out) = run_help(&["--help"], &env(&[]), &[], false);
    assert_eq!(code, 0);
    assert!(out.contains("You already know this."));
}

#[test]
fn help_rejects_unknown_flags_and_extra_arguments() {
    let (code, out) = run_help(&["--nope"], &env(&[]), &[], false);
    assert_eq!(code, 1);
    assert_eq!(out, "");
    let (code, out) = run_help(&["--log", "extra"], &env(&[]), &[], false);
    assert_eq!(code, 1);
    assert_eq!(out, "");
    let (code, _) = run_help(&["-h"], &env(&[]), &[], false);
    assert_eq!(code, 1, "aliases are not looked up by --help <name>");
}
