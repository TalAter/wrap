//! Handing the draft to an external editor (`Ctrl-G` in the dialog).

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
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
        .filter(|&cut| {
            name.get(cut..)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".exe"))
        })
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

struct Terminal {
    file: File,
    group: i32,
    editor_group: Option<i32>,
    modes: libc::termios,
}
impl Terminal {
    fn open() -> Option<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .ok()?;
        let group = unsafe { libc::tcgetpgrp(file.as_raw_fd()) };
        let mut modes = unsafe { std::mem::zeroed() };
        if group != unsafe { libc::getpgrp() }
            || unsafe { libc::tcgetattr(file.as_raw_fd(), &mut modes) } < 0
        {
            return None;
        }
        Some(Self {
            file,
            group,
            editor_group: None,
            modes,
        })
    }

    fn restore(&self) {
        let fd = self.file.as_raw_fd();
        let current = unsafe { libc::tcgetpgrp(fd) };
        // Known editor groups remain ours after their members are reparented.
        // A shell that resumed Wrap in the background keeps its terminal.
        if current != self.group
            && (current <= 0
                || !(self.editor_group == Some(current)
                    || crate::shell::group_belongs_to_child(
                        current,
                        self.editor_group
                            .unwrap_or_else(|| unsafe { libc::getpid() }),
                    )))
        {
            return;
        }
        if foreground(fd, self.group).is_ok() {
            unsafe { libc::tcsetattr(fd, libc::TCSANOW, &self.modes) };
        }
    }

    async fn relay_stop(&self, editor: i32, cancel: &CancellationToken) {
        {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // Consume only stop notifications; Tokio owns the child's exit status.
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    editor as libc::id_t,
                    &mut info,
                    libc::WSTOPPED | libc::WNOHANG,
                )
            } != 0
                || unsafe { info.si_pid() } != editor
            {
                return;
            }
        }
        let fd = self.file.as_raw_fd();
        let mut modes = unsafe { std::mem::zeroed() };
        let saved = unsafe { libc::tcgetattr(fd, &mut modes) } == 0;
        self.restore();
        loop {
            // The caller shell tracks Wrap's group, not the editor's group.
            unsafe { libc::kill(libc::getpid(), libc::SIGSTOP) };
            // The host polls signals while this future yields. Pending
            // cancellation must settle before another stop or terminal handoff.
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            if unsafe { libc::tcgetpgrp(fd) } == self.group {
                break;
            }
            // `bg` leaves the shell in charge; wait for a foreground resume.
        }
        if saved {
            unsafe { libc::tcsetattr(fd, libc::TCSANOW, &modes) };
        }
        if foreground(fd, editor).is_ok() {
            unsafe { libc::killpg(editor, libc::SIGCONT) };
        }
    }
}
fn foreground(fd: i32, group: i32) -> io::Result<()> {
    unsafe {
        let mut mask = std::mem::zeroed();
        let mut previous = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        libc::sigaddset(&mut mask, libc::SIGTTOU);
        let error = libc::pthread_sigmask(libc::SIG_BLOCK, &mask, &mut previous);
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        let result = if libc::tcsetpgrp(fd, group) < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
        result
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        self.restore();
    }
}
struct ProcessGroup(i32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if self.0 > 0 {
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
        }
    }
}

/// Seed `cache/compose.md`, run the editor with chrome on the terminal (or
/// stderr without a terminal), then read the saved draft back.
///
/// `Ok(Some(text))`: exit 0 and a non-empty file (one trailing newline
/// stripped). `Ok(None)`: keep the current draft silently — the file came
/// back empty, or `cancel` fired. Cancellation leaves GUI editors running;
/// terminal editors are killed and reaped before returning. `Err(notice)`:
/// keep the draft and show `notice` as chrome — a non-zero exit or launch failure.
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
    let cancel = cancel.unwrap_or_default();
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let file = home.resolve(COMPOSE_FILE);
    let editor_error = |e: io::Error| format!("Editor error: {e}");
    home.write(COMPOSE_FILE, draft).map_err(editor_error)?;

    let mut command = tokio::process::Command::new(&resolved.path);
    if let Some(flag) = resolved.meta.wait_flag {
        command.arg(flag);
    }
    let mut terminal = if resolved.meta.gui {
        None
    } else {
        Terminal::open()
    };
    command.arg(&file).stdin(if let Some(tty) = &terminal {
        Stdio::from(tty.file.try_clone().map_err(editor_error)?)
    } else {
        Stdio::null()
    });
    let output = || {
        OpenOptions::new()
            .write(true)
            .open("/dev/tty")
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::from(io::stderr()))
    };
    command.stdout(output()).stderr(output());
    if resolved.meta.gui {
        // GUI waits cannot read the live dialog through stdin or /dev/tty.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    } else {
        command.process_group(0).kill_on_drop(true);
        if let Some(tty) = &terminal {
            let fd = tty.file.as_raw_fd();
            unsafe {
                command.pre_exec(move || foreground(fd, libc::getpgrp()));
            }
        }
    }
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let mut child = command.spawn().map_err(editor_error)?;
    let mut group = ProcessGroup(if resolved.meta.gui {
        0
    } else {
        child.id().unwrap() as i32
    });
    if let Some(tty) = &mut terminal {
        tty.editor_group = Some(group.0);
    }
    let mut job_control = tokio::time::interval(Duration::from_millis(20));
    let status = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                if resolved.meta.gui {
                    tokio::spawn(async move { let _ = child.wait().await; });
                } else {
                    drop(group);
                    let _ = child.wait().await;
                }
                return Ok(None);
            }
            status = child.wait() => break status.map_err(editor_error)?,
            _ = job_control.tick(), if terminal.is_some() => {
                terminal.as_ref().unwrap().relay_stop(group.0, &cancel).await;
            }
        }
    };
    group.0 = 0;
    drop(terminal);

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
