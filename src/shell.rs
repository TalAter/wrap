//! Running commands under the user's shell: captured for probes and steps,
//! inherited for the final command the user actually sees.
//!
//! The shell runs as `$SHELL +m -ic <command>`. `-i` sources the user's rc
//! files so aliases, functions and PATH additions behave as at their own
//! prompt. `+m` asks for job control off; interactive bash still runs each
//! foreground job in its own process group and hands it the terminal, which
//! is what lets Ctrl-C reach the command without reaching Wrap.
//!
//! Process groups follow the terminal. A child that may touch the terminal
//! (stdin is the tty) stays in Wrap's foreground group: a background group
//! cannot read the tty, and interactive bash stops itself until it is in the
//! foreground. A child with no terminal gets its own group so cancelling it
//! ends everything it started. Either way a cancelled child is killed with
//! whatever bash gave the terminal to, and the terminal comes back to Wrap.
//!
//! Piped-input bytes are never streamed to children; they live at
//! `$WRAP_TEMP_DIR/input` and commands read them from there.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, IsTerminal};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;
use std::process::{ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use tokio::io::AsyncReadExt;
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
/// inherits it. Cancelling the token kills the child, its process group when
/// it has one of its own, and whatever holds the terminal, then fails with
/// `ErrorKind::Interrupted`.
pub async fn execute_shell_command(
    command: &str,
    mode: ShellMode,
    cancel: Option<CancellationToken>,
) -> io::Result<ShellExec> {
    // Only `SHELL` matters here; a non-UTF-8 value elsewhere in the
    // environment must not matter at all.
    let env: HashMap<String, String> = std::env::var_os("SHELL")
        .map(|v| ("SHELL".to_string(), v.to_string_lossy().into_owned()))
        .into_iter()
        .collect();
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
    let own_group = matches!(stdin, ChildStdin::Null);
    let terminal = Terminal::claim();
    let spawn = Spawn {
        shell,
        command,
        own_group,
        terminal: terminal.as_ref(),
    };
    let (status, stdout, stderr) = match mode {
        ShellMode::Capture => run_captured(&spawn, stdin, cancel).await?,
        ShellMode::Inherit => {
            let status = run_inherited(&spawn, stdin, cancel).await?;
            (status, String::new(), String::new())
        }
    };
    // A grandchild that bash handed the terminal and then outlived it
    // leaves the foreground elsewhere; the next terminal read would fail.
    if let Some(terminal) = &terminal {
        terminal.reclaim();
    }
    Ok(ShellExec {
        exit_code: exit_code(status),
        exec_ms: (start.elapsed().as_secs_f64() * 1000.0).round() as u64,
        shell: shell.to_string(),
        stdout,
        stderr,
    })
}

/// Read a child's pipe to its end on a task of its own, so a child writing
/// more than the pipe buffer never blocks on a full pipe while being waited
/// on. Aborting the task releases a pipe a surviving grandchild holds open.
pub(crate) fn drain_pipe<R>(pipe: Option<R>) -> tokio::task::JoinHandle<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes).await;
        }
        bytes
    })
}

/// What one shell invocation needs to start and, if cancelled, to end.
struct Spawn<'a> {
    shell: &'a str,
    command: &'a str,
    /// Put the child in a process group of its own (no terminal involved).
    own_group: bool,
    terminal: Option<&'a Terminal>,
}

impl Spawn<'_> {
    /// `$SHELL +m -ic <command>` with the stdio given.
    fn command(&self, stdin: ChildStdin, stdout: Stdio, stderr: Stdio) -> std::process::Command {
        let mut builder = std::process::Command::new(self.shell);
        builder
            .args(["+m", "-ic", self.command])
            .stdin(stdin)
            .stdout(stdout)
            .stderr(stderr);
        if self.own_group {
            builder.process_group(0);
        }
        builder
    }

    /// End a cancelled child: first whatever group bash handed the terminal
    /// to, then the child's own group when it left ours (bash moves itself
    /// out under job control; headless children start apart), then the
    /// child itself. An interactive shell ignores SIGTERM, so only SIGKILL
    /// reliably ends it. The caller reaps the child afterwards.
    fn kill(&self, pid: libc::pid_t) {
        // SAFETY: plain signal sends; `pid` is a child that has not been
        // reaped, so neither it nor its group id can have been recycled.
        unsafe {
            let own = libc::getpgrp();
            if let Some(foreground) = self.terminal.and_then(Terminal::foreign_foreground) {
                libc::killpg(foreground, libc::SIGKILL);
            }
            let group = libc::getpgid(pid);
            if group > 0 && group != own {
                libc::killpg(group, libc::SIGKILL);
            }
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

async fn run_captured(
    spawn: &Spawn<'_>,
    stdin: ChildStdin,
    cancel: Option<CancellationToken>,
) -> io::Result<(ExitStatus, String, String)> {
    let mut child =
        tokio::process::Command::from(spawn.command(stdin, Stdio::piped(), Stdio::piped()))
            .kill_on_drop(true)
            .spawn()?;
    let pid = child.id().expect("child not yet reaped") as libc::pid_t;
    let stdout = drain_pipe(child.stdout.take());
    let stderr = drain_pipe(child.stderr.take());
    let status = match cancel {
        Some(token) => tokio::select! {
            status = child.wait() => status?,
            _ = token.cancelled() => {
                spawn.kill(pid);
                let _ = child.wait().await;
                // A survivor in our own group may still hold the pipes open.
                stdout.abort();
                stderr.abort();
                return Err(cancelled());
            }
        },
        None => child.wait().await?,
    };
    let stdout = stdout.await.unwrap_or_default();
    let stderr = stderr.await.unwrap_or_default();
    Ok((
        status,
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

async fn run_inherited(
    spawn: &Spawn<'_>,
    stdin: ChildStdin,
    cancel: Option<CancellationToken>,
) -> io::Result<ExitStatus> {
    let signals = IgnoredSignals::install()?;
    let mut builder = spawn.command(stdin, Stdio::inherit(), Stdio::inherit());
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
                spawn.kill(pid);
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

/// The controlling terminal, held while this process is its foreground
/// group. Interactive bash hands the terminal to each foreground job; a job
/// that outlives a killed shell keeps it, and every later terminal read in
/// Wrap would fail. `None` when there is no terminal or another group (the
/// user's shell, after `w … &`) is in the foreground: then nothing is
/// touched.
struct Terminal {
    tty: File,
    group: libc::pid_t,
}

impl Terminal {
    fn claim() -> Option<Terminal> {
        let tty = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .ok()?;
        // SAFETY: plain queries on a valid fd.
        let (group, foreground) = unsafe { (libc::getpgrp(), libc::tcgetpgrp(tty.as_raw_fd())) };
        (foreground == group).then_some(Terminal { tty, group })
    }

    /// The foreground group when it is not ours any more.
    fn foreign_foreground(&self) -> Option<libc::pid_t> {
        // SAFETY: a query on a valid fd.
        let foreground = unsafe { libc::tcgetpgrp(self.tty.as_raw_fd()) };
        (foreground > 0 && foreground != self.group).then_some(foreground)
    }

    /// Take the terminal back when a child left it elsewhere.
    fn reclaim(&self) {
        if self.foreign_foreground().is_some() {
            let _ = set_foreground(self.tty.as_raw_fd(), self.group);
        }
    }
}

/// `tcsetpgrp` from a background group normally stops the caller with
/// SIGTTOU; block it on this thread for the duration.
fn set_foreground(fd: libc::c_int, group: libc::pid_t) -> io::Result<()> {
    // SAFETY: the signal set is initialised before use and the mask is
    // restored on every path.
    unsafe {
        let mut mask: libc::sigset_t = std::mem::zeroed();
        let mut previous: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        libc::sigaddset(&mut mask, libc::SIGTTOU);
        if libc::sigprocmask(libc::SIG_BLOCK, &mask, &mut previous) == -1 {
            return Err(io::Error::last_os_error());
        }
        let result = if libc::tcsetpgrp(fd, group) == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
        result
    }
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
