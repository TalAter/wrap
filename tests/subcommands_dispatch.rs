//! Dispatch, registry derivation and `--version`.

use std::collections::HashMap;
use std::sync::Mutex;

use wrap::chrome::{self, Notification};
use wrap::cli::Modifiers;
use wrap::config::settings::{SETTINGS, SettingKind};
use wrap::config::{Config, ResolvedConfig, resolve_settings};
use wrap::home::WrapHome;
use wrap::subcommands::{
    Bucket, Context, FlagKind, Footprints, commands, dispatch_to, options, version,
};

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

fn run(flag: &str, args: &[&str]) -> (i32, Vec<String>, String) {
    let home = WrapHome::new("/nonexistent/wrap-home");
    let env = HashMap::new();
    let config = config(&env);
    let ctx = Context {
        home: &home,
        env: &env,
        config: &config,
        stdout_is_tty: false,
        stdin_is_tty: false,
        terminal_rows: None,
        which: &never_which,
        forget_dialog: &no_dialog,
    };
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut out = Vec::new();
    let (code, chrome) = capture_chrome(|| dispatch_to(flag, &args, &ctx, &mut out));
    (code, chrome, String::from_utf8(out).unwrap())
}

// ── registry ─────────────────────────────────────────────────────

#[test]
fn commands_are_registered_in_help_order_with_aliases() {
    let cmds = commands();
    let flags: Vec<&str> = cmds.iter().map(|c| c.flag.as_str()).collect();
    assert_eq!(
        flags,
        ["--log", "--help", "--version", "--completion", "--forget"]
    );
    let by_flag = |f: &str| cmds.iter().find(|c| c.flag == f).unwrap();
    assert_eq!(by_flag("--help").aliases, ["-h"]);
    assert_eq!(by_flag("--version").aliases, ["-v"]);
    assert_eq!(by_flag("--completion").aliases, ["--completions"]);
    assert!(by_flag("--log").aliases.is_empty());
    assert!(cmds.iter().all(|c| matches!(c.kind, FlagKind::Command)));
}

#[test]
fn options_derive_from_every_flagged_setting() {
    let opts = options();
    for setting in SETTINGS.iter().filter(|s| !s.flags.is_empty()) {
        let opt = opts
            .iter()
            .find(|o| o.id == setting.id)
            .unwrap_or_else(|| panic!("{} missing", setting.id));
        assert_eq!(opt.flag, setting.flags[0]);
        assert_eq!(opt.aliases, setting.flags[1..]);
        assert_eq!(opt.description, setting.description);
        assert_eq!(opt.help.as_deref(), setting.help);
        let expected_usage = setting
            .usage
            .map(str::to_string)
            .unwrap_or_else(|| format!("w {}", setting.flags[0]));
        assert_eq!(opt.usage, expected_usage);
        match &opt.kind {
            FlagKind::Option { takes_value, env } => {
                assert_eq!(*takes_value, setting.kind != SettingKind::Bool);
                assert_eq!(env, setting.env);
            }
            FlagKind::Command => panic!("{} should be an option", setting.id),
        }
    }
    let ids: Vec<&str> = opts.iter().map(|o| o.id.as_str()).collect();
    assert!(ids.contains(&"verbose") && ids.contains(&"noAnimation") && ids.contains(&"model"));
    assert!(
        !ids.contains(&"maxRounds")
            && !ids.contains(&"nerdFonts")
            && !ids.contains(&"defaultProvider")
    );
    let model = opts.iter().find(|o| o.id == "model").unwrap();
    assert!(model.aliases.contains(&"--provider".to_string()));
    assert_eq!(
        model.completion,
        Some(wrap::subcommands::CompletionKind::Providers)
    );
}

// ── dispatch ─────────────────────────────────────────────────────

#[test]
fn unknown_flag_reports_and_exits_1() {
    let (code, chrome, out) = run("--nope", &[]);
    assert_eq!(code, 1);
    assert_eq!(chrome, ["Unknown flag: --nope"]);
    assert_eq!(out, "");
}

#[test]
fn aliases_resolve_to_their_command() {
    let (code, chrome, out) = run("-v", &[]);
    assert_eq!(code, 0);
    assert!(chrome.is_empty());
    assert_eq!(out, format!("{}\n", env!("CARGO_PKG_VERSION")));
    let (code, _, out) = run("-h", &["--log"]);
    assert_eq!(code, 0);
    assert!(out.contains("Show log entries"));
}

#[test]
fn dispatch_passes_arguments_through() {
    let (code, chrome, out) = run("--help", &["--log", "extra"]);
    assert_eq!(code, 1);
    assert_eq!(chrome, ["--help takes at most one argument."]);
    assert_eq!(out, "");
    let (code, chrome, out) = run("--help", &["--nope"]);
    assert_eq!(code, 1);
    assert_eq!(chrome, ["Unknown flag: --nope"]);
    assert_eq!(out, "");
}

// ── version ──────────────────────────────────────────────────────

#[test]
fn version_prints_the_crate_version_to_stdout() {
    let mut out = Vec::new();
    let (code, chrome) = capture_chrome(|| version::run(&[], &mut out));
    assert_eq!(code, 0);
    assert!(chrome.is_empty());
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text, format!("{}\n", env!("CARGO_PKG_VERSION")));
    let semver =
        regex::Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$").unwrap();
    assert!(semver.is_match(text.trim()));
}

#[test]
fn version_rejects_arguments() {
    let mut out = Vec::new();
    let (code, chrome) = capture_chrome(|| version::run(&["extra".to_string()], &mut out));
    assert_eq!(code, 1);
    assert_eq!(chrome, ["--version does not take an argument."]);
    assert!(out.is_empty());
}
