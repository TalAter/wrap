use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::sync::Mutex;

use wrap::chrome::{self, Notification};
use wrap::cli::Modifiers;
use wrap::config::{Config, ResolvedConfig, resolve_settings};
use wrap::home::WrapHome;
use wrap::subcommands::forget::{
    Footprint, Unit, cache_footprint, delete_cache, delete_logs, delete_memory, delete_scratch,
    format_footprint, logs_footprint, memory_footprint, scratch_footprint, tmp_base,
};
use wrap::subcommands::{Bucket, Context, Footprints, forget};

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

fn write(path: impl AsRef<Path>, content: &str) {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

fn ok(count: u64, bytes: u64) -> Footprint {
    Footprint::Ok { count, bytes }
}

// ── footprints ───────────────────────────────────────────────────

#[test]
fn memory_footprint_counts_facts_and_bytes_of_both_files() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    assert_eq!(memory_footprint(&home), Footprint::Empty);
    let mem = r#"{"/":[{"fact":"a"},{"fact":"b"}],"/tmp":[{"fact":"c"}]}"#;
    write(dir.path().join("memory.json"), mem);
    write(dir.path().join("tool-watchlist.json"), "[]");
    assert_eq!(memory_footprint(&home), ok(3, mem.len() as u64 + 2));
}

#[test]
fn memory_footprint_is_unreadable_for_corrupt_memory_and_ok_for_watchlist_only() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    write(dir.path().join("memory.json"), "{not json");
    assert_eq!(memory_footprint(&home), Footprint::Unreadable);
    fs::remove_file(dir.path().join("memory.json")).unwrap();
    write(dir.path().join("tool-watchlist.json"), "[]");
    assert_eq!(memory_footprint(&home), ok(0, 2));
}

#[test]
fn logs_footprint_counts_lines_and_includes_trace_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    assert_eq!(logs_footprint(&home), Footprint::Empty);
    let jsonl = dir.path().join("logs/wrap.jsonl");
    write(&jsonl, "");
    assert_eq!(logs_footprint(&home), Footprint::Empty);
    write(&jsonl, "\n");
    assert_eq!(logs_footprint(&home), Footprint::Empty);
    write(&jsonl, "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n");
    assert_eq!(logs_footprint(&home), ok(3, 24));
    write(&jsonl, "{}\n{}\n");
    assert_eq!(logs_footprint(&home), ok(2, 6));
    write(&jsonl, "x");
    assert_eq!(logs_footprint(&home), ok(1, 1));
    write(dir.path().join("logs/traces/abc.json"), &"x".repeat(500));
    assert_eq!(logs_footprint(&home), ok(1, 501));
    fs::remove_file(&jsonl).unwrap();
    assert_eq!(logs_footprint(&home), ok(0, 500));
}

#[test]
fn symlinked_log_bucket_counts_only_the_link_and_preserves_external_records() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    fs::write(outside.path().join("wrap.jsonl"), "private record\n").unwrap();
    let link = home.resolve("logs");
    symlink(outside.path(), &link).unwrap();
    assert_eq!(
        logs_footprint(&home),
        ok(0, fs::symlink_metadata(&link).unwrap().len())
    );
    assert!(delete_logs(&home).removed);
    assert_eq!(
        fs::read_to_string(outside.path().join("wrap.jsonl")).unwrap(),
        "private record\n"
    );
}

#[test]
fn cache_footprint_is_recursive_and_ignores_siblings() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    write(dir.path().join("memory.json"), "xxxxx");
    assert_eq!(cache_footprint(&home), Footprint::Empty);
    fs::create_dir(dir.path().join("cache")).unwrap();
    assert_eq!(cache_footprint(&home), Footprint::Empty);
    write(dir.path().join("cache/a.json"), "aa");
    write(dir.path().join("cache/sub/b.json"), "bbbb");
    assert_eq!(cache_footprint(&home), ok(2, 6));
}

#[test]
fn scratch_footprint_matches_prefix_dirs_only() {
    let base = tempfile::tempdir().unwrap();
    let base = base.path();
    assert_eq!(scratch_footprint(base), Footprint::Empty);
    assert_eq!(
        scratch_footprint(&base.join("does-not-exist")),
        Footprint::Empty
    );
    write(base.join("wrap-scratch-aaa/f"), "12345");
    write(base.join("wrap-scratch-bbb/f"), "xyz");
    write(base.join("wrap-other-zzz/f"), "zzzzzzzz");
    write(base.join("wrap-scratch-file"), "zzzz");
    symlink(
        base.join("does-not-exist"),
        base.join("wrap-scratch-broken"),
    )
    .unwrap();
    assert_eq!(scratch_footprint(base), ok(2, 8));
}

#[test]
fn format_footprint_states_units_and_separators() {
    assert_eq!(format_footprint(Unit::Facts, &Footprint::Empty), "(empty)");
    assert_eq!(
        format_footprint(Unit::Facts, &Footprint::Unreadable),
        "(unreadable)"
    );
    assert_eq!(
        format_footprint(Unit::Facts, &ok(23, 4096)),
        "(23 facts, 4K)"
    );
    assert_eq!(
        format_footprint(Unit::Entries, &ok(1203, 4 * 1024 * 1024)),
        "(1,203 entries, 4M)"
    );
    assert_eq!(
        format_footprint(Unit::Entries, &ok(1_234_567, 0)),
        "(1,234,567 entries, 0B)"
    );
    assert_eq!(format_footprint(Unit::Files, &ok(1, 100)), "(1 file, 100B)");
    assert_eq!(
        format_footprint(Unit::Entries, &ok(1, 10)),
        "(1 entry, 10B)"
    );
    assert_eq!(format_footprint(Unit::Facts, &ok(1, 10)), "(1 fact, 10B)");
    assert_eq!(format_footprint(Unit::Dirs, &ok(1, 0)), "(1 dir, 0B)");
    assert_eq!(format_footprint(Unit::Dirs, &ok(3, 0)), "(3 dirs, 0B)");
}

// ── deletes ──────────────────────────────────────────────────────

#[test]
fn delete_memory_removes_both_files_and_leaves_config() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let r = delete_memory(&home);
    assert!(!r.removed && r.errors.is_empty());
    write(dir.path().join("memory.json"), "{}");
    write(dir.path().join("tool-watchlist.json"), "[]");
    write(dir.path().join("config.jsonc"), "{}");
    let r = delete_memory(&home);
    assert!(r.removed && r.errors.is_empty());
    assert!(!dir.path().join("memory.json").exists());
    assert!(!dir.path().join("tool-watchlist.json").exists());
    assert!(dir.path().join("config.jsonc").exists());
    write(dir.path().join("memory.json"), "{}");
    assert!(delete_memory(&home).removed);
}

#[test]
fn delete_memory_records_non_enoent_failures() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    fs::create_dir(dir.path().join("memory.json")).unwrap();
    let r = delete_memory(&home);
    assert_eq!(r.errors, vec![dir.path().join("memory.json")]);
    assert!(!r.removed);
}

#[test]
fn delete_logs_removes_the_whole_logs_tree() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let r = delete_logs(&home);
    assert!(!r.removed && r.errors.is_empty());
    write(dir.path().join("logs/wrap.jsonl"), "{}\n");
    write(dir.path().join("logs/traces/abc.json"), "{}");
    let r = delete_logs(&home);
    assert!(r.removed && r.errors.is_empty());
    assert!(!dir.path().join("logs").exists());
}

#[test]
fn delete_cache_handles_dirs_files_and_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    assert!(!delete_cache(&home).removed);
    write(dir.path().join("cache/a"), "x");
    write(dir.path().join("cache/sub/b"), "y");
    assert!(delete_cache(&home).removed);
    assert!(!dir.path().join("cache").exists());

    write(dir.path().join("cache"), "oops");
    let r = delete_cache(&home);
    assert!(r.removed && r.errors.is_empty());
    assert!(!dir.path().join("cache").exists());

    let target = tempfile::tempdir().unwrap();
    write(target.path().join("survives.txt"), "important");
    fs::create_dir(dir.path().join("cache")).unwrap();
    symlink(target.path(), dir.path().join("cache/link-to-target")).unwrap();
    let r = delete_cache(&home);
    assert!(r.removed && r.errors.is_empty());
    assert!(!dir.path().join("cache").exists());
    assert_eq!(
        fs::read_to_string(target.path().join("survives.txt")).unwrap(),
        "important"
    );
}

#[test]
fn delete_scratch_removes_prefixed_entries_only() {
    let base = tempfile::tempdir().unwrap();
    let base = base.path();
    let r = delete_scratch(base);
    assert!(!r.removed && r.errors.is_empty());
    let r = delete_scratch(&base.join("does-not-exist"));
    assert!(!r.removed && r.errors.is_empty());
    write(base.join("wrap-scratch-aaa/f"), "x");
    fs::create_dir(base.join("wrap-scratch-bbb")).unwrap();
    fs::create_dir(base.join("other-dir")).unwrap();
    write(base.join("loose-file"), "x");
    let r = delete_scratch(base);
    assert!(r.removed && r.errors.is_empty());
    assert!(!base.join("wrap-scratch-aaa").exists());
    assert!(!base.join("wrap-scratch-bbb").exists());
    assert!(base.join("other-dir").exists());
    assert!(base.join("loose-file").exists());
}

#[test]
fn dangling_scratch_symlink_is_unlinked_but_not_counted_as_removed() {
    let base = tempfile::tempdir().unwrap();
    let base = base.path();
    symlink(
        base.join("missing-target"),
        base.join("wrap-scratch-dangling"),
    )
    .unwrap();
    let r = delete_scratch(base);
    assert!(!r.removed && r.errors.is_empty());
    assert!(
        base.join("wrap-scratch-dangling")
            .symlink_metadata()
            .is_err()
    );
}

#[test]
fn tmp_base_honours_tmpdir_and_falls_back_to_tmp() {
    let env: HashMap<String, String> = [("TMPDIR".to_string(), "/custom/tmp/".to_string())].into();
    assert_eq!(tmp_base(&env), Path::new("/custom/tmp"));
    assert_eq!(tmp_base(&HashMap::new()), Path::new("/tmp"));
}

// ── run ──────────────────────────────────────────────────────────

fn seed_all(root: &Path) {
    write(root.join("memory.json"), r#"{"/":[{"fact":"x"}]}"#);
    write(root.join("tool-watchlist.json"), "[]");
    write(root.join("logs/wrap.jsonl"), "{}\n");
    write(root.join("cache/c"), "c");
    write(root.join("config.jsonc"), "{}");
}

struct Harness {
    home: WrapHome,
    env: HashMap<String, String>,
    config: ResolvedConfig,
    stdin_is_tty: bool,
}

impl Harness {
    fn new(root: &Path, tmp: &Path, flags: &[&str], stdin_is_tty: bool) -> Harness {
        let env: HashMap<String, String> =
            [("TMPDIR".to_string(), tmp.to_string_lossy().into_owned())].into();
        let modifiers = Modifiers {
            flags: flags.iter().map(|f| f.to_string()).collect(),
            ..Modifiers::default()
        };
        let config = resolve_settings(&modifiers, &env, &Config::default()).unwrap();
        Harness {
            home: WrapHome::new(root),
            env,
            config,
            stdin_is_tty,
        }
    }

    fn run(
        &self,
        args: &[&str],
        dialog: impl FnOnce(&Footprints) -> Option<Vec<Bucket>>,
    ) -> (i32, Vec<String>) {
        let never_which = |_: &str| false;
        let unused_dialog = |_: &Footprints| None;
        let ctx = Context {
            home: &self.home,
            env: &self.env,
            config: &self.config,
            stdout_is_tty: false,
            stdin_is_tty: self.stdin_is_tty,
            terminal_rows: None,
            which: &never_which,
            forget_dialog: &unused_dialog,
        };
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        capture_chrome(|| forget::run(&args, &ctx, dialog))
    }
}

fn no_dialog(_: &Footprints) -> Option<Vec<Bucket>> {
    panic!("dialog must not open")
}

#[test]
fn yolo_flag_deletes_all_four_buckets_without_a_dialog() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    seed_all(dir.path());
    write(tmp.path().join("wrap-scratch-test-1/f"), "x");
    let h = Harness::new(dir.path(), tmp.path(), &[], false);
    let (code, chrome) = h.run(&["--yolo"], no_dialog);
    assert_eq!(code, 0);
    assert_eq!(chrome, ["🗑️ Forgotten."]);
    assert!(!dir.path().join("memory.json").exists());
    assert!(!dir.path().join("tool-watchlist.json").exists());
    assert!(!dir.path().join("logs").exists());
    assert!(!dir.path().join("cache").exists());
    assert!(!tmp.path().join("wrap-scratch-test-1").exists());
    assert!(dir.path().join("config.jsonc").exists());
}

#[test]
fn yolo_from_config_also_skips_the_dialog_and_uses_nerd_glyph() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    seed_all(dir.path());
    let mut h = Harness::new(dir.path(), tmp.path(), &["yolo"], false);
    h.config.nerd_fonts = true;
    let (code, chrome) = h.run(&[], no_dialog);
    assert_eq!(code, 0);
    assert_eq!(chrome, ["\u{f1f8} Forgotten."]);
    assert!(!dir.path().join("memory.json").exists());
}

#[test]
fn fresh_install_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let h = Harness::new(dir.path(), tmp.path(), &[], false);
    let (code, chrome) = h.run(&["--yolo"], no_dialog);
    assert_eq!(code, 0);
    assert!(chrome.is_empty());
}

#[test]
fn prompt_text_after_forget_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    seed_all(dir.path());
    let h = Harness::new(dir.path(), tmp.path(), &[], true);
    let (code, chrome) = h.run(&["delete", "everything"], no_dialog);
    assert_eq!(code, 1);
    assert_eq!(chrome, ["--forget cannot be combined with a prompt."]);
    let (code, chrome) = h.run(&["--yolo", "something", "extra"], no_dialog);
    assert_eq!(code, 1);
    assert_eq!(chrome, ["--forget cannot be combined with a prompt."]);
    assert!(dir.path().join("memory.json").exists());
}

#[test]
fn no_tty_without_yolo_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    seed_all(dir.path());
    let h = Harness::new(dir.path(), tmp.path(), &[], false);
    let (code, chrome) = h.run(&[], no_dialog);
    assert_eq!(code, 1);
    assert_eq!(chrome, ["Forget error: --forget requires a TTY or --yolo."]);
    assert!(dir.path().join("memory.json").exists());
}

#[test]
fn dialog_receives_footprints_and_cancel_or_empty_selection_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    seed_all(dir.path());
    let h = Harness::new(dir.path(), tmp.path(), &[], true);
    let seen = Cell::new(None);
    let (code, chrome) = h.run(&[], |fp| {
        seen.set(Some(fp.clone()));
        None
    });
    assert_eq!(code, 0);
    assert!(chrome.is_empty());
    let fp = seen.take().unwrap();
    assert!(matches!(fp.memory, Footprint::Ok { count: 1, .. }));
    assert!(matches!(fp.logs, Footprint::Ok { count: 1, .. }));
    assert!(matches!(fp.cache, Footprint::Ok { count: 1, .. }));
    assert_eq!(fp.scratch, Footprint::Empty);
    let (code, chrome) = h.run(&[], |_| Some(vec![]));
    assert_eq!(code, 0);
    assert!(chrome.is_empty());
    assert!(dir.path().join("memory.json").exists());
}

#[test]
fn dialog_selection_deletes_only_chosen_buckets() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    seed_all(dir.path());
    let h = Harness::new(dir.path(), tmp.path(), &[], true);
    let (code, chrome) = h.run(&[], |_| Some(vec![Bucket::Logs, Bucket::Cache]));
    assert_eq!(code, 0);
    assert_eq!(chrome, ["🗑️ Forgotten."]);
    assert!(dir.path().join("memory.json").exists());
    assert!(!dir.path().join("logs").exists());
    assert!(!dir.path().join("cache").exists());
}

#[test]
fn removal_failures_report_each_path_and_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("memory.json")).unwrap();
    write(dir.path().join("cache/c"), "c");
    let h = Harness::new(dir.path(), tmp.path(), &[], false);
    let (code, chrome) = h.run(&["--yolo"], no_dialog);
    assert_eq!(code, 1);
    assert_eq!(
        chrome,
        [
            format!(
                "Forget error: could not remove {}.",
                dir.path().join("memory.json").display()
            ),
            "🗑️ Forgotten.".to_string(),
        ]
    );
    assert!(!dir.path().join("cache").exists());
}
