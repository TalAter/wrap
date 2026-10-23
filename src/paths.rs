//! Path helpers: canonical resolution with `~` expansion, display forms, and
//! a `PATH` lookup for external tools.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// The user's home directory (`$HOME`, else the passwd entry, else `/`).
pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Canonical absolute form of `p`: a leading `~` expands to the home
/// directory, a relative path resolves against `cwd` (or the process cwd),
/// symlinks are followed. `None` when the path does not exist.
pub fn resolve_path(p: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let expanded = match p.strip_prefix('~') {
        Some(rest) => PathBuf::from(format!("{}{rest}", home_dir().display())),
        None => PathBuf::from(p),
    };
    let joined = match cwd {
        Some(cwd) if !expanded.is_absolute() => cwd.join(expanded),
        _ => expanded,
    };
    std::fs::canonicalize(joined).ok()
}

/// Display form with the home directory prefix replaced by `~`. For
/// user-facing messages only — never for storage or prompt text.
pub fn pretty_path(p: impl AsRef<Path>) -> String {
    let p = p.as_ref();
    let home = home_dir();
    if p == home {
        return "~".to_string();
    }
    match p.strip_prefix(&home) {
        Ok(rest) if !rest.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => p.display().to_string(),
    }
}

/// Locate an executable the way a shell would: a name containing `/` is
/// checked as given, anything else is searched along `$PATH`.
pub fn which(cmd: &str) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    if cmd.contains('/') {
        return is_executable(Path::new(cmd)).then(|| cmd.to_string());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(cmd))
        .find(|candidate| is_executable(candidate))
        .map(|found| found.to_string_lossy().into_owned())
}

fn is_executable(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
