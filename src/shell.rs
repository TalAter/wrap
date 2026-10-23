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
//! foreground. While such a child runs captured, Wrap ignores SIGTTIN and
//! SIGTTOU: once bash hands the terminal to the step's job, the dialog's
//! reads fail with EIO (which it tolerates) instead of stopping Wrap behind
//! the user's shell. A child with no terminal gets its own group so
//! cancelling it ends everything it started. A cancelled child is killed
//! together with the groups it started, including the one bash gave the
//! terminal to, and then the terminal comes back to Wrap. A foreground group
//! that is not the child's (the user's shell after a suspend and `bg`) is
//! never signalled and never has the terminal taken from it: interactive bash
//! restores the terminal to Wrap's group when it exits, so Wrap watches the
//! foreground while a captured child runs and hands the terminal back to a
//! shell that took it meanwhile, letting job control stop Wrap until `fg`.
//!
//! Piped-input bytes are never streamed to children; they live at
//! `$WRAP_TEMP_DIR/input` and commands read them from there.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, IsTerminal};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;
use std::process::{ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

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
/// it has one of its own, and the child's job holding the terminal, then
/// fails with `ErrorKind::Interrupted`.
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
    // The dialog stays up and keeps reading the terminal while a captured
    // child shares it; the child's job may own the terminal meanwhile.
    let shares_terminal = mode == ShellMode::Capture && terminal.is_some();
    let ignored = if shares_terminal {
        Some(IgnoredSignals::install(JOB_CONTROL_SIGNALS)?)
    } else {
        None
    };
    let spawn = Spawn {
        shell,
        command,
        own_group,
        terminal: terminal.as_ref(),
        child_defaults: if shares_terminal {
            JOB_CONTROL_SIGNALS
        } else {
            &[]
        },
    };
    let (pid, status, stdout, stderr) = match mode {
        ShellMode::Capture => run_captured(&spawn, stdin, cancel).await?,
        ShellMode::Inherit => {
            let (pid, status) = run_inherited(&spawn, stdin, cancel).await?;
            (pid, status, String::new(), String::new())
        }
    };
    // A job that bash handed the terminal and that outlived it leaves the
    // foreground elsewhere; the next terminal read would fail.
    let handed_back = terminal.as_ref().is_some_and(|t| t.reclaim(pid));
    drop(ignored);
    if handed_back {
        // The shell took the terminal while the child ran and keeps it: wait
        // stopped like any background job that needs the terminal, until
        // the shell resumes this process with `fg`.
        // SAFETY: a plain signal to this process; the default action stops it.
        unsafe { libc::kill(libc::getpid(), libc::SIGTTIN) };
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

/// How often the foreground group is sampled while a captured child runs.
const FOREGROUND_WATCH: Duration = Duration::from_millis(50);
/// Ignored in Wrap while a captured child shares the terminal.
const JOB_CONTROL_SIGNALS: &[libc::c_int] = &[libc::SIGTTIN, libc::SIGTTOU];
/// Ignored in Wrap while a child owns the terminal.
const INTERRUPT_SIGNALS: &[libc::c_int] = &[libc::SIGINT, libc::SIGTERM];

/// What one shell invocation needs to start and, if cancelled, to end.
struct Spawn<'a> {
    shell: &'a str,
    command: &'a str,
    /// Put the child in a process group of its own (no terminal involved).
    own_group: bool,
    terminal: Option<&'a Terminal>,
    /// Signals Wrap ignores meanwhile that the child must handle normally.
    child_defaults: &'static [libc::c_int],
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
        let defaults = self.child_defaults;
        // SAFETY: `signal` is async-signal-safe and the callback touches
        // nothing else.
        unsafe {
            builder.pre_exec(move || {
                for signal in defaults {
                    libc::signal(*signal, libc::SIG_DFL);
                }
                Ok(())
            });
        }
        builder
    }

    /// End a cancelled child: first the child's job holding the terminal,
    /// then the child's own group when it left ours (bash moves itself out
    /// under job control; headless children start apart), then the child
    /// itself; finally the terminal comes back. An interactive shell ignores
    /// SIGTERM, so only SIGKILL reliably ends it. The caller reaps the child
    /// afterwards.
    fn kill(&self, pid: libc::pid_t) {
        // SAFETY: plain signal sends; `pid` is a child that has not been
        // reaped, so neither it nor its group id can have been recycled.
        unsafe {
            let own = libc::getpgrp();
            if let Some(terminal) = self.terminal {
                terminal.kill_child_foreground(pid);
            }
            let group = libc::getpgid(pid);
            if group > 0 && group != own {
                libc::killpg(group, libc::SIGKILL);
            }
            libc::kill(pid, libc::SIGKILL);
        }
        if let Some(terminal) = self.terminal {
            terminal.reclaim(pid);
        }
    }
}

async fn run_captured(
    spawn: &Spawn<'_>,
    stdin: ChildStdin,
    cancel: Option<CancellationToken>,
) -> io::Result<(libc::pid_t, ExitStatus, String, String)> {
    let mut child =
        tokio::process::Command::from(spawn.command(stdin, Stdio::piped(), Stdio::piped()))
            .kill_on_drop(true)
            .spawn()?;
    let pid = child.id().expect("child not yet reaped") as libc::pid_t;
    let stdout = drain_pipe(child.stdout.take());
    let stderr = drain_pipe(child.stderr.take());
    let cancelled_token = cancel.unwrap_or_default();
    let mut watch = tokio::time::interval(FOREGROUND_WATCH);
    let status = loop {
        tokio::select! {
            status = child.wait() => break status?,
            _ = watch.tick() => {
                if let Some(terminal) = spawn.terminal {
                    terminal.observe(pid);
                }
            }
            _ = cancelled_token.cancelled() => {
                spawn.kill(pid);
                let _ = child.wait().await;
                // A survivor in our own group may still hold the pipes open.
                stdout.abort();
                stderr.abort();
                return Err(cancelled());
            }
        }
    };
    let stdout = stdout.await.unwrap_or_default();
    let stderr = stderr.await.unwrap_or_default();
    Ok((
        pid,
        status,
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

async fn run_inherited(
    spawn: &Spawn<'_>,
    stdin: ChildStdin,
    cancel: Option<CancellationToken>,
) -> io::Result<(libc::pid_t, ExitStatus)> {
    let signals = IgnoredSignals::install(INTERRUPT_SIGNALS)?;
    // Ctrl-C has to end the command even though Wrap itself survives it.
    let spawn = Spawn {
        child_defaults: INTERRUPT_SIGNALS,
        ..*spawn
    };
    let mut builder = spawn.command(stdin, Stdio::inherit(), Stdio::inherit());
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
    Ok((pid, status.map_err(io::Error::other)??))
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
    /// A foreground group this process already killed; its members may
    /// linger as zombies, so it is reclaimed without another look.
    killed: Cell<Option<libc::pid_t>>,
    /// The last foreground group observed while the child ran.
    observed: Cell<libc::pid_t>,
    /// A group that took the terminal from this process while the child
    /// ran and did not get there through the child: the user's shell after
    /// a suspend and `bg`. Cleared again once the foreground is back with
    /// this process (`fg`) or the child's job.
    displaced_by: Cell<Option<libc::pid_t>>,
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
        (foreground == group).then_some(Terminal {
            tty,
            group,
            killed: Cell::new(None),
            observed: Cell::new(group),
            displaced_by: Cell::new(None),
        })
    }

    fn foreground(&self) -> libc::pid_t {
        // SAFETY: a query on a valid fd.
        unsafe { libc::tcgetpgrp(self.tty.as_raw_fd()) }
    }

    /// Sample the foreground while `child` runs.
    fn observe(&self, child: libc::pid_t) {
        let foreground = self.foreground();
        if foreground <= 0 || foreground == self.observed.get() {
            return;
        }
        self.observed.set(foreground);
        let ours = foreground == self.group || group_belongs_to_child(foreground, child);
        self.displaced_by.set((!ours).then_some(foreground));
    }

    /// The foreground group when it is a job of `child`'s rather than ours.
    /// The user's shell holds the foreground after a suspend and `bg`; it
    /// is never a candidate, so it never has the terminal taken from it.
    fn child_foreground(&self, child: libc::pid_t) -> Option<libc::pid_t> {
        let foreground = self.foreground();
        if foreground <= 0 || foreground == self.group {
            return None;
        }
        (self.killed.get() == Some(foreground) || group_belongs_to_child(foreground, child))
            .then_some(foreground)
    }

    fn kill_child_foreground(&self, child: libc::pid_t) {
        if let Some(foreground) = self.child_foreground(child) {
            // SAFETY: a plain signal send to a group the child started.
            unsafe { libc::killpg(foreground, libc::SIGKILL) };
            self.killed.set(Some(foreground));
        }
    }

    /// Take the terminal back when `child`'s job left it elsewhere. When a
    /// shell took the terminal while the child ran and the child's exit
    /// handed it to this process regardless, it goes back to that shell;
    /// true when it did.
    fn reclaim(&self, child: libc::pid_t) -> bool {
        if self.foreground() == self.group {
            if let Some(shell) = self.displaced_by.get()
                && !group_is_empty(shell)
            {
                return set_foreground(self.tty.as_raw_fd(), shell).is_ok();
            }
        } else if self.child_foreground(child).is_some() {
            let _ = set_foreground(self.tty.as_raw_fd(), self.group);
        }
        false
    }
}

/// Whether process group `group` is one `child` started: the child's own
/// group, a group with nobody left in it, or a group with a live member
/// descended from `child`. On Linux descent is read from `/proc`. Without it
/// (macOS) the groups that must never be touched are the shell that started
/// Wrap and the session leader; any other foreground group got there through
/// the child.
pub fn group_belongs_to_child(group: libc::pid_t, child: libc::pid_t) -> bool {
    // SAFETY: a plain query.
    if unsafe { libc::getpgid(child) } == group {
        return true;
    }
    group_is_empty(group) || group_descends_from(group, child)
}

fn group_is_empty(group: libc::pid_t) -> bool {
    // SAFETY: a signal of 0 only checks for members.
    let failed = unsafe { libc::killpg(group, 0) } == -1;
    failed && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(target_os = "linux")]
fn group_descends_from(group: libc::pid_t, child: libc::pid_t) -> bool {
    // The group id is its leader's pid; once the leader is gone, any live
    // member stands in for it.
    let members: Vec<libc::pid_t> = if parent_of(group).is_some() {
        vec![group]
    } else {
        std::fs::read_dir("/proc")
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|e| e.file_name().to_str()?.parse::<libc::pid_t>().ok())
                    // SAFETY: a plain query.
                    .filter(|&pid| unsafe { libc::getpgid(pid) } == group)
                    .collect()
            })
            .unwrap_or_default()
    };
    members.into_iter().any(|member| {
        let mut pid = member;
        for _ in 0..1024 {
            if pid == child {
                return true;
            }
            match parent_of(pid) {
                Some(parent) if parent > 1 && parent != pid => pid = parent,
                _ => return false,
            }
        }
        false
    })
}

#[cfg(target_os = "linux")]
fn parent_of(pid: libc::pid_t) -> Option<libc::pid_t> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name may contain spaces; the fields follow its closing paren.
    let (_, fields) = stat.rsplit_once(')')?;
    fields.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(not(target_os = "linux"))]
fn group_descends_from(group: libc::pid_t, _child: libc::pid_t) -> bool {
    // SAFETY: plain queries.
    let (parent, session) = unsafe { (libc::getpgid(libc::getppid()), libc::getsid(0)) };
    group != parent && group != session
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

/// Ignore signals in Wrap while a child runs: SIGINT and SIGTERM while the
/// child owns the terminal (it sits in the same foreground process group,
/// so Ctrl-C still reaches it and Wrap survives to record the exit code),
/// SIGTTIN and SIGTTOU while a captured child shares it (a terminal read
/// from behind the child's job then fails with EIO instead of stopping
/// Wrap). Dispositions are restored on drop.
struct IgnoredSignals {
    previous: Vec<(libc::c_int, libc::sigaction)>,
    _exclusive: MutexGuard<'static, ()>,
}

impl IgnoredSignals {
    fn install(signals: &[libc::c_int]) -> io::Result<Self> {
        let exclusive = SIGNAL_SCOPE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut guard = IgnoredSignals {
            previous: Vec::with_capacity(signals.len()),
            _exclusive: exclusive,
        };
        for &signal in signals {
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
