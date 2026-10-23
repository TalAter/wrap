//! Running commands under the user's shell: captured for probes and steps,
//! inherited for the final command the user actually sees.
//!
//! The shell runs as `$SHELL +m -ic <command>`. `-i` sources the user's rc
//! files so aliases, functions and PATH additions behave as at their own
//! prompt. `+m` asks for job control off; interactive bash still runs each
//! foreground job in its own process group and hands it the terminal, which
//! is what lets Ctrl-C reach the command without reaching Wrap.
//!
//! Piped-input bytes are never streamed to children; they live at
//! `$WRAP_TEMP_DIR/input` and commands read them from there.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, IsTerminal};
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;
use std::process::{ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::temp::ensure_temp_dir;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellMode {
    /// Pipe stdout and stderr back to Wrap.
    Capture,
    /// Hand the terminal to the child; stdout and stderr stay empty.
    Inherit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellExec {
    /// The child's exit code; a signal death reports `128 + signal`.
    pub exit_code: i32,
    /// Wall-clock duration in milliseconds.
    pub exec_ms: u64,
    /// The shell that ran the command, e.g. `/bin/zsh`.
    pub shell: String,
    pub stdout: String,
    pub stderr: String,
}

/// `$SHELL`, or `sh` when unset or empty.
pub fn shell_from_env(env: &HashMap<String, String>) -> String {
    env.get("SHELL")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "sh".to_string())
}

/// Where a child reads keystrokes from.
pub enum ChildStdin {
    /// Wrap's own stdin is a terminal.
    Inherit,
    /// Wrap was piped into, but a controlling terminal exists: interactive
    /// children like `vim` and `sudo` still get real keystrokes.
    Tty(File),
    /// No terminal at all (headless).
    Null,
}

pub fn choose_child_stdin(is_tty: bool, open_tty: impl FnOnce() -> io::Result<File>) -> ChildStdin {
    if is_tty {
        return ChildStdin::Inherit;
    }
    match open_tty() {
        Ok(tty) => ChildStdin::Tty(tty),
        Err(_) => ChildStdin::Null,
    }
}

fn default_child_stdin() -> ChildStdin {
    choose_child_stdin(io::stdin().is_terminal(), || File::open("/dev/tty"))
}

impl From<ChildStdin> for Stdio {
    fn from(stdin: ChildStdin) -> Stdio {
        match stdin {
            ChildStdin::Inherit => Stdio::inherit(),
            ChildStdin::Tty(file) => Stdio::from(file),
            ChildStdin::Null => Stdio::null(),
        }
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1)
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "command cancelled")
}

/// Run `command` under `$SHELL`. Creates `$WRAP_TEMP_DIR` first so the child
/// inherits it. Cancelling the token kills the child (the shell process; in
/// inherit mode a foreground grandchild may outlive it) and fails with
/// `ErrorKind::Interrupted`.
pub async fn execute_shell_command(
    command: &str,
    mode: ShellMode,
    cancel: Option<CancellationToken>,
) -> io::Result<ShellExec> {
    let env: HashMap<String, String> = std::env::vars().collect();
    execute_with_shell(command, &shell_from_env(&env), mode, cancel).await
}

/// [`execute_shell_command`] with an explicit shell program.
pub async fn execute_with_shell(
    command: &str,
    shell: &str,
    mode: ShellMode,
    cancel: Option<CancellationToken>,
) -> io::Result<ShellExec> {
    ensure_temp_dir()?;
    let start = Instant::now();
    let stdin = default_child_stdin();
    let (status, stdout, stderr) = match mode {
        ShellMode::Capture => run_captured(shell, command, stdin, cancel).await?,
        ShellMode::Inherit => {
            let status = run_inherited(shell, command, stdin, cancel).await?;
            (status, String::new(), String::new())
        }
    };
    Ok(ShellExec {
        exit_code: exit_code(status),
        exec_ms: (start.elapsed().as_secs_f64() * 1000.0).round() as u64,
        shell: shell.to_string(),
        stdout,
        stderr,
    })
}

async fn run_captured(
    shell: &str,
    command: &str,
    stdin: ChildStdin,
    cancel: Option<CancellationToken>,
) -> io::Result<(ExitStatus, String, String)> {
    let child = tokio::process::Command::new(shell)
        .args(["+m", "-ic", command])
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    // `wait_with_output` drains both pipes while waiting, so a child writing
    // more than the pipe buffer never blocks on a full pipe.
    let output = match cancel {
        Some(token) => tokio::select! {
            output = child.wait_with_output() => output?,
            _ = token.cancelled() => return Err(cancelled()),
        },
        None => child.wait_with_output().await?,
    };
    Ok((
        output.status,
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

async fn run_inherited(
    shell: &str,
    command: &str,
    stdin: ChildStdin,
    cancel: Option<CancellationToken>,
) -> io::Result<ExitStatus> {
    let signals = IgnoredSignals::install()?;
    let mut builder = std::process::Command::new(shell);
    builder
        .args(["+m", "-ic", command])
        .stdin(stdin)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // The child must not inherit Wrap's ignored dispositions: Ctrl-C has to
    // end the command even though Wrap itself survives it.
    // SAFETY: `signal` is async-signal-safe and the callback touches nothing else.
    unsafe {
        builder.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            Ok(())
        });
    }
    let mut child = builder.spawn()?;
    let pid = child.id() as libc::pid_t;
    let mut wait = tokio::task::spawn_blocking(move || child.wait());
    let status = match cancel {
        Some(token) => tokio::select! {
            status = &mut wait => status,
            _ = token.cancelled() => {
                // An interactive shell ignores SIGTERM, so only SIGKILL
                // reliably ends it. A foreground grandchild may outlive it.
                // SAFETY: `pid` is the child spawned above and is still
                // being waited on, so it cannot have been recycled.
                unsafe { libc::kill(pid, libc::SIGKILL) };
                let _ = (&mut wait).await;
                drop(signals);
                return Err(cancelled());
            }
        },
        None => (&mut wait).await,
    };
    drop(signals);
    status.map_err(io::Error::other)?
}

static SIGNAL_SCOPE: Mutex<()> = Mutex::new(());

/// Ignore SIGINT and SIGTERM in Wrap while a terminal-owning child runs. The
/// child sits in the same foreground process group, so Ctrl-C still reaches
/// it; Wrap survives to record the exit code. Dispositions are restored on
/// drop.
struct IgnoredSignals {
    previous: Vec<(libc::c_int, libc::sigaction)>,
    _exclusive: MutexGuard<'static, ()>,
}

impl IgnoredSignals {
    fn install() -> io::Result<Self> {
        let exclusive = SIGNAL_SCOPE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut guard = IgnoredSignals {
            previous: Vec::with_capacity(2),
            _exclusive: exclusive,
        };
        for signal in [libc::SIGINT, libc::SIGTERM] {
            // SAFETY: sigaction fills `previous`; the new action is SIG_IGN
            // with an empty mask.
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = libc::SIG_IGN;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(signal, &action, &mut previous) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }
}

impl Drop for IgnoredSignals {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.iter().rev() {
            // SAFETY: restores the disposition sigaction returned at install.
            unsafe { libc::sigaction(*signal, previous, std::ptr::null_mut()) };
        }
    }
}
