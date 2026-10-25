//! `--forget`: wipe Wrap's persisted user data in four file-level buckets
//! (memory, logs, cache, scratch dirs). Config is never touched.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::chrome::chrome;
use crate::home::WrapHome;
use crate::memory::{count_facts, load_memory};
use crate::temp::{dir_stats, format_size};

use super::Context;
use super::registry::{self, CliFlag};

const SCRATCH_PREFIX: &str = "wrap-scratch-";

pub fn flag() -> CliFlag {
    registry::command(
        "--forget",
        &[],
        "forget",
        "Delete persisted user data (memory, logs, cache, temp files)",
        "w --forget [--yolo]",
        Some(
            "Interactive multi-select dialog. Select which of the four buckets to wipe:\n  Memory        ~/.wrap/memory.json + ~/.wrap/tool-watchlist.json\n  Logs          ~/.wrap/logs/ (wrap.jsonl + trace sidecars)\n  Cache         ~/.wrap/cache/\n  Temp files    $TMPDIR/wrap-scratch-*\n\n--yolo skips the dialog and deletes all four.\nconfig.jsonc is never touched — use `rm` if you want it gone."
                .to_string(),
        ),
        None,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    Memory,
    Logs,
    Cache,
    Scratch,
}

impl Bucket {
    pub const ALL: [Bucket; 4] = [Bucket::Memory, Bucket::Logs, Bucket::Cache, Bucket::Scratch];
}

// ── Footprints ───────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Footprint {
    Empty,
    Unreadable,
    Ok { count: u64, bytes: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Facts,
    Entries,
    Files,
    Dirs,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Footprints {
    pub memory: Footprint,
    pub logs: Footprint,
    pub cache: Footprint,
    pub scratch: Footprint,
}

fn file_bytes(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Fact count from `memory.json` plus the bytes of it and the tool
/// watchlist. Unreadable when `memory.json` exists but does not parse.
pub fn memory_footprint(home: &WrapHome) -> Footprint {
    let memory_path = home.resolve("memory.json");
    let memory_bytes = file_bytes(&memory_path);
    let watchlist_bytes = file_bytes(&home.resolve("tool-watchlist.json"));
    if memory_bytes == 0 && watchlist_bytes == 0 {
        return Footprint::Empty;
    }
    let mut count = 0;
    if memory_bytes > 0 {
        match load_memory(home) {
            Ok(memory) => count = count_facts(&memory) as u64,
            Err(_) => return Footprint::Unreadable,
        }
    }
    Footprint::Ok {
        count,
        bytes: memory_bytes + watchlist_bytes,
    }
}

/// Invocation count is the JSONL line count; bytes include trace sidecars
/// so the number matches what deleting the logs bucket removes.
pub fn logs_footprint(home: &WrapHome) -> Footprint {
    if let Ok(meta) = fs::symlink_metadata(home.resolve("logs"))
        && meta.is_symlink()
    {
        return Footprint::Ok {
            count: 0,
            bytes: meta.len(),
        };
    }
    let jsonl_path = home.resolve("logs/wrap.jsonl");
    let jsonl_bytes = file_bytes(&jsonl_path);
    let trace_bytes = dir_stats(&home.resolve("logs/traces")).bytes;
    let mut count = 0;
    if jsonl_bytes > 0 {
        let content = fs::read(&jsonl_path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        let trimmed = content.strip_suffix('\n').unwrap_or(&content);
        if !trimmed.is_empty() {
            count = trimmed.split('\n').count() as u64;
        }
    }
    if count == 0 && trace_bytes == 0 {
        return Footprint::Empty;
    }
    Footprint::Ok {
        count,
        bytes: jsonl_bytes + trace_bytes,
    }
}

/// Recursive file count and bytes under `cache/`.
pub fn cache_footprint(home: &WrapHome) -> Footprint {
    let stats = dir_stats(&home.resolve("cache"));
    if stats.files == 0 {
        return Footprint::Empty;
    }
    Footprint::Ok {
        count: stats.files,
        bytes: stats.bytes,
    }
}

fn scratch_entries(tmp_base: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(tmp_base) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(SCRATCH_PREFIX))
        .map(|e| e.path())
        .collect()
}

/// Count of `wrap-scratch-*` directories under `tmp_base` and their
/// recursive bytes. Files and dangling links with the prefix are ignored.
pub fn scratch_footprint(tmp_base: &Path) -> Footprint {
    let mut count = 0;
    let mut bytes = 0;
    for path in scratch_entries(tmp_base) {
        if !fs::metadata(&path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        count += 1;
        bytes += dir_stats(&path).bytes;
    }
    if count == 0 {
        return Footprint::Empty;
    }
    Footprint::Ok { count, bytes }
}

fn with_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `(empty)`, `(unreadable)` or `(1,234 facts, 12K)`.
pub fn format_footprint(unit: Unit, footprint: &Footprint) -> String {
    let Footprint::Ok { count, bytes } = footprint else {
        return match footprint {
            Footprint::Empty => "(empty)".into(),
            _ => "(unreadable)".into(),
        };
    };
    let (singular, plural) = match unit {
        Unit::Facts => ("fact", "facts"),
        Unit::Entries => ("entry", "entries"),
        Unit::Files => ("file", "files"),
        Unit::Dirs => ("dir", "dirs"),
    };
    let noun = if *count == 1 { singular } else { plural };
    format!(
        "({} {noun}, {})",
        with_thousands(*count),
        format_size(*bytes)
    )
}

// ── Deletes ──────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeleteResult {
    /// True when at least one existing entry was removed; a missing path
    /// is a silent success and does not count.
    pub removed: bool,
    /// Paths that failed to delete for reasons other than being absent.
    pub errors: Vec<PathBuf>,
}

impl DeleteResult {
    fn merge(&mut self, other: DeleteResult) {
        self.removed |= other.removed;
        self.errors.extend(other.errors);
    }
}

fn unlink_if_present(path: PathBuf, result: &mut DeleteResult) {
    match fs::remove_file(&path) {
        Ok(()) => result.removed = true,
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => result.errors.push(path),
    }
}

/// Remove `path` whatever it is: a directory tree, a file, or a symlink
/// (the link itself, never its target). Reports `removed` only when the
/// path resolved to something; a dangling link is unlinked silently.
fn remove_tree(path: PathBuf) -> DeleteResult {
    let mut result = DeleteResult::default();
    let existed = match fs::metadata(&path) {
        Ok(_) => true,
        Err(e) => e.kind() != ErrorKind::NotFound,
    };
    let outcome = match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(&path),
        Ok(_) => fs::remove_file(&path),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    };
    match outcome {
        Ok(()) => result.removed = existed,
        Err(_) => result.errors.push(path),
    }
    result
}

pub fn delete_memory(home: &WrapHome) -> DeleteResult {
    let mut result = DeleteResult::default();
    unlink_if_present(home.resolve("memory.json"), &mut result);
    unlink_if_present(home.resolve("tool-watchlist.json"), &mut result);
    result
}

pub fn delete_logs(home: &WrapHome) -> DeleteResult {
    remove_tree(home.resolve("logs"))
}

pub fn delete_cache(home: &WrapHome) -> DeleteResult {
    remove_tree(home.resolve("cache"))
}

pub fn delete_scratch(tmp_base: &Path) -> DeleteResult {
    let mut result = DeleteResult::default();
    for path in scratch_entries(tmp_base) {
        result.merge(remove_tree(path));
    }
    result
}

/// The directory scratch dirs live in: `TMPDIR`, `TMP` or `TEMP` (trailing
/// slash dropped), else `/tmp`.
pub fn tmp_base(env: &HashMap<String, String>) -> PathBuf {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| env.get(*key).filter(|v| !v.is_empty()));
    match configured {
        Some(dir) => {
            let trimmed = dir.trim_end_matches('/');
            PathBuf::from(if trimmed.is_empty() { "/" } else { trimmed })
        }
        None => PathBuf::from("/tmp"),
    }
}

// ── Run ──────────────────────────────────────────────────────────

/// `show_dialog` opens the bucket checklist and returns the selection, or
/// `None` when the user cancels. `--yolo` (flag or config) skips it and
/// selects every bucket.
pub fn run(
    args: &[String],
    ctx: &Context,
    show_dialog: impl FnOnce(&Footprints) -> Option<Vec<Bucket>>,
) -> i32 {
    let yolo = ctx.config.yolo || args.iter().any(|a| a == "--yolo");
    if args.iter().any(|a| a != "--yolo") {
        chrome("--forget cannot be combined with a prompt.", None);
        return 1;
    }

    let tmp = tmp_base(ctx.env);
    let footprints = Footprints {
        memory: memory_footprint(ctx.home),
        logs: logs_footprint(ctx.home),
        cache: cache_footprint(ctx.home),
        scratch: scratch_footprint(&tmp),
    };

    let selected = if yolo {
        Bucket::ALL.to_vec()
    } else {
        if !ctx.stdin_is_tty {
            chrome("Forget error: --forget requires a TTY or --yolo.", None);
            return 1;
        }
        match show_dialog(&footprints) {
            Some(buckets) if !buckets.is_empty() => buckets,
            _ => return 0,
        }
    };

    let mut outcome = DeleteResult::default();
    for bucket in selected {
        outcome.merge(match bucket {
            Bucket::Memory => delete_memory(ctx.home),
            Bucket::Logs => delete_logs(ctx.home),
            Bucket::Cache => delete_cache(ctx.home),
            Bucket::Scratch => delete_scratch(&tmp),
        });
    }

    for path in &outcome.errors {
        chrome(
            &format!("Forget error: could not remove {}.", path.display()),
            None,
        );
    }
    if outcome.removed {
        let icon = if ctx.config.nerd_fonts {
            "\u{f1f8}"
        } else {
            "🗑️"
        };
        chrome(&format!("{icon} Forgotten."), None);
    }
    if outcome.errors.is_empty() { 0 } else { 1 }
}
