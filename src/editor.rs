//! Handing the draft to an external editor (`Ctrl-G` in the dialog).

use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::home::WrapHome;

const COMPOSE_FILE: &str = "cache/compose.md";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorMeta {
    pub display_name: String,
    /// Flag that makes a GUI editor block until the file is closed. Absent
    /// for terminal-owning editors, which block naturally.
    pub wait_flag: Option<&'static str>,
    /// GUI editors fork and detach from the terminal: they need the wait flag
    /// and stay out of the terminal handoff flow.
    pub gui: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedEditor {
    /// Absolute path, or the bare name when `$VISUAL`/`$EDITOR` is not on PATH.
    pub path: String,
    /// Basename without `.exe`: the [`EDITORS`] key.
    pub key: String,
    pub meta: EditorMeta,
}

pub struct KnownEditor {
    pub display_name: &'static str,
    pub wait_flag: Option<&'static str>,
    pub gui: bool,
}

const fn gui(display_name: &'static str, wait_flag: &'static str) -> KnownEditor {
    KnownEditor {
        display_name,
        wait_flag: Some(wait_flag),
        gui: true,
    }
}

const fn terminal(display_name: &'static str) -> KnownEditor {
    KnownEditor {
        display_name,
        wait_flag: None,
        gui: false,
    }
}

/// Known editors by basename, in auto-detect order: the first one on PATH
/// wins. GUI editors without a documented wait flag are left out so they
/// take the terminal-owning path, which surfaces the mismatch instead of
/// silently losing the buffer.
pub static EDITORS: &[(&str, KnownEditor)] = &[
    ("code", gui("VS Code", "-w")),
    ("code-insiders", gui("VS Code Insiders", "-w")),
    ("cursor", gui("Cursor", "-w")),
    ("windsurf", gui("Windsurf", "-w")),
    ("codium", gui("VSCodium", "-w")),
    ("antigravity", gui("Antigravity", "-w")),
    ("subl", gui("Sublime Text", "--wait")),
    ("atom", gui("Atom", "--wait")),
    ("vim", terminal("Vim")),
    ("nvim", terminal("Neovim")),
    ("nano", terminal("Nano")),
    ("emacs", terminal("Emacs")),
    ("hx", terminal("Helix")),
    ("helix", terminal("Helix")),
    ("micro", terminal("Micro")),
    ("vi", terminal("Vi")),
];

fn meta_for(key: &str) -> EditorMeta {
    match EDITORS.iter().find(|(k, _)| *k == key) {
        Some((_, known)) => EditorMeta {
            display_name: known.display_name.to_string(),
            wait_flag: known.wait_flag,
            gui: known.gui,
        },
        None => EditorMeta {
            display_name: key.to_string(),
            wait_flag: None,
            gui: false,
        },
    }
}

/// Basename without a trailing `.exe`, splitting on `/` and `\` so a Windows
/// path collapses to its name even on POSIX.
pub fn editor_key(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let trimmed = name
        .len()
        .checked_sub(4)
        .filter(|&cut| name[cut..].eq_ignore_ascii_case(".exe"))
        .map_or(name, |cut| &name[..cut]);
    trimmed.to_string()
}

/// `$VISUAL`, else `$EDITOR`, else the first [`EDITORS`] entry on PATH.
/// An env editor not on PATH keeps its bare name. The caller caches the
/// result for the process lifetime.
pub fn resolve_editor(
    env_visual: Option<&str>,
    env_editor: Option<&str>,
    which: impl Fn(&str) -> Option<String>,
) -> Option<ResolvedEditor> {
    let env_candidate = [env_visual, env_editor]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|v| !v.is_empty());
    if let Some(candidate) = env_candidate {
        let path = which(candidate).unwrap_or_else(|| candidate.to_string());
        let key = editor_key(&path);
        return Some(ResolvedEditor {
            meta: meta_for(&key),
            path,
            key,
        });
    }
    EDITORS.iter().find_map(|(key, _)| {
        let path = which(key)?;
        Some(ResolvedEditor {
            path,
            key: key.to_string(),
            meta: meta_for(key),
        })
    })
}

/// [`resolve_editor`] over the process environment and PATH.
pub fn resolve_editor_from_env() -> Option<ResolvedEditor> {
    let visual = std::env::var("VISUAL").ok();
    let editor = std::env::var("EDITOR").ok();
    resolve_editor(visual.as_deref(), editor.as_deref(), crate::paths::which)
}

// Editors save atomically by renaming over the target, leaving a brief window
// where the path does not resolve.
async fn read_with_retry(path: &Path) -> io::Result<String> {
    const ATTEMPTS: usize = 5;
    for attempt in 0..ATTEMPTS {
        match tokio::fs::read_to_string(path).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound && attempt + 1 < ATTEMPTS => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            result => return result,
        }
    }
    unreachable!("the loop returns on its last attempt")
}

/// Seed `cache/compose.md` with `draft`, run the editor on it with inherited
/// stdio, and read it back once the editor exits.
///
/// `Ok(Some(text))`: exit 0 and a non-empty file (one trailing newline
/// stripped). `Ok(None)`: keep the current draft silently — the file came
/// back empty, or `cancel` fired (the editor keeps running; only the wait is
/// abandoned). `Err(notice)`: keep the draft and show `notice` as chrome — a
/// non-zero exit or a launch failure.
///
/// The buffer lives under `$WRAP_HOME` rather than `$WRAP_TEMP_DIR`: macOS's
/// `/private/var/folders` file watching made VS Code report a fresh temp file
/// as deleted mid-edit, and a stable path narrows the rename race on save.
pub async fn spawn_editor(
    resolved: &ResolvedEditor,
    draft: &str,
    home: &WrapHome,
    cancel: Option<CancellationToken>,
) -> Result<Option<String>, String> {
    let file = home.resolve(COMPOSE_FILE);
    let editor_error = |e: io::Error| format!("Editor error: {e}");
    home.write(COMPOSE_FILE, draft).map_err(editor_error)?;

    let mut command = tokio::process::Command::new(&resolved.path);
    if let Some(flag) = resolved.meta.wait_flag {
        command.arg(flag);
    }
    command
        .arg(&file)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(token) = &cancel
        && token.is_cancelled()
    {
        return Ok(None);
    }
    let mut child = command.spawn().map_err(editor_error)?;
    let status = match cancel {
        Some(token) => tokio::select! {
            status = child.wait() => status,
            _ = token.cancelled() => return Ok(None),
        },
        None => child.wait().await,
    }
    .map_err(editor_error)?;

    if !status.success() {
        let code = status
            .code()
            .map_or("signal".to_string(), |c| c.to_string());
        return Err(format!(
            "{} exited with code {code} — keeping current draft",
            resolved.meta.display_name
        ));
    }
    let raw = read_with_retry(&file).await.map_err(editor_error)?;
    let text = raw.strip_suffix('\n').unwrap_or(&raw);
    Ok((!text.is_empty()).then(|| text.to_string()))
}
