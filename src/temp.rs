//! The per-invocation scratch directory (`$WRAP_TEMP_DIR`) and the prompt
//! section that describes its contents.

use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub const TEMP_DIR_ENV: &str = "WRAP_TEMP_DIR";

static CREATE: Mutex<()> = Mutex::new(());

/// Create `$TMPDIR/wrap-scratch-XXXXXX` on first use and export its path as
/// `WRAP_TEMP_DIR` for every process Wrap spawns afterwards. Later calls return
/// the same path. Call it right before the directory is needed (just before a
/// shell spawns) so invocations that never run a command leave nothing on disk.
///
/// Cleanup is deferred to the OS's `$TMPDIR` policy: a future resume flow may
/// want to pick up where a previous invocation left off.
///
/// This is the one place Wrap mutates its own environment. Rust's `set_var`
/// is synchronised against std's own environment access (`Command`
/// inheritance, `var_os`), but not against foreign code calling `getenv`
/// concurrently; Wrap has no such code on other threads.
pub fn ensure_temp_dir() -> io::Result<PathBuf> {
    let _serialised = CREATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = std::env::var_os(TEMP_DIR_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(existing));
    }
    let path = make_scratch_dir()?;
    // SAFETY: serialised by `CREATE`; no non-Rust code reads the environment
    // from another thread while this runs (see the doc comment above).
    unsafe { std::env::set_var(TEMP_DIR_ENV, &path) };
    Ok(path)
}

fn make_scratch_dir() -> io::Result<PathBuf> {
    let template = std::env::temp_dir().join("wrap-scratch-XXXXXX");
    let mut bytes = template.as_os_str().as_bytes().to_vec();
    bytes.push(0);
    // SAFETY: `bytes` is a NUL-terminated, writable buffer ending in the
    // six `X`s mkdtemp requires; it outlives the call.
    let created = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast::<libc::c_char>()) };
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    bytes.pop();
    Ok(PathBuf::from(OsString::from_vec(bytes)))
}

static PROMPT_CONSTANTS: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("prompt/constants.json"))
        .expect("prompt/constants.json is valid JSON")
});

fn prompt_constant(key: &str) -> &'static str {
    PROMPT_CONSTANTS[key]
        .as_str()
        .unwrap_or_else(|| panic!("prompt/constants.json lacks {key}"))
}

/// The prompt section listing everything under `$WRAP_TEMP_DIR`, recursively
/// and sorted, with sizes on files. Paths are shown in the env-var form so the
/// model never sees (or hardcodes) the absolute path. An unset, missing or
/// empty directory renders the empty state. Never creates the directory.
pub fn format_temp_dir_section(dir: Option<&Path>) -> String {
    let header = prompt_constant("sectionTempDir");
    let mut lines = Vec::new();
    if let Some(dir) = dir {
        walk(dir, "", &mut lines);
    }
    if lines.is_empty() {
        return format!("{header}\n{}", prompt_constant("tempDirEmpty"));
    }
    format!("{header}\n{}", lines.join("\n"))
}

/// [`format_temp_dir_section`] for the directory exported in the process env.
pub fn format_temp_dir_section_from_env() -> String {
    let dir = std::env::var_os(TEMP_DIR_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    format_temp_dir_section(dir.as_deref())
}

fn walk(root: &Path, rel: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root.join(rel)) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let Ok(meta) = std::fs::symlink_metadata(root.join(&child_rel)) else {
            continue;
        };
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            out.push(format!("${TEMP_DIR_ENV}/{child_rel}/"));
            walk(root, &child_rel, out);
        } else {
            out.push(format!(
                "${TEMP_DIR_ENV}/{child_rel} ({})",
                format_size(meta.len())
            ));
        }
    }
}

/// `512B`, `4K`, `5M` — rounded to the nearest unit.
pub fn format_size(bytes: u64) -> String {
    const K: f64 = 1024.0;
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{}K", (bytes as f64 / K).round())
    } else {
        format!("{}M", (bytes as f64 / (K * K)).round())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DirStats {
    pub files: u64,
    pub bytes: u64,
}

/// Recursive file count and byte sum under `root`; a missing path is empty.
/// Symlinks count once at their own size and are never followed.
pub fn dir_stats(root: &Path) -> DirStats {
    let mut stats = DirStats::default();
    if let Ok(meta) = std::fs::symlink_metadata(root)
        && meta.is_symlink()
    {
        return DirStats {
            files: 1,
            bytes: meta.len(),
        };
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                stats.files += 1;
                stats.bytes += meta.len();
            }
        }
    }
    stats
}
