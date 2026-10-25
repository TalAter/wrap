//! Running commands under the user's shell: captured for probes and steps,
//! inherited for the final command the user actually sees.
//!
//! The shell runs as `$SHELL +m -ic <command>`. `-i` sources the user's rc
//! files so aliases, functions and PATH additions behave as at their own
//! prompt. Headless commands also run `set +m` after interactive startup so
//! background jobs stay in the child's isolated group after its exit.
//! `+m` asks for job control off; interactive bash still runs each
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
    let terminal = Terminal::claim(mode);
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
        // Interactive startup can override +m, including in headless Bash 3.2.
        let command = if self.own_group {
            format!("set +m; {}", self.command)
        } else {
            self.command.to_owned()
        };
        builder
            .args(["+m", "-ic", &command])
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

    /// End a cancelled child: first its descendants, then its terminal job,
    /// then the child's own group when it left ours (bash moves itself out
    /// under job control; headless children start apart), then the child
    /// itself; finally the terminal comes back. An interactive shell ignores
    /// SIGTERM, so only SIGKILL reliably ends it. The caller reaps the child
    /// afterwards if it has not already exited while descendants drain.
    fn kill(&self, pid: libc::pid_t, running: bool) {
        if running {
            kill_descendants(pid);
        }
        // SAFETY: signal only the child's isolated group, its terminal job,
        // or the direct child while it has not been reaped.
        unsafe {
            let own = libc::getpgrp();
            if let Some(terminal) = self.terminal {
                terminal.kill_child_foreground(pid);
            }
            let group = if self.own_group {
                pid
            } else if running {
                libc::getpgid(pid)
            } else {
                -1
            };
            if group > 0 && group != own {
                libc::killpg(group, libc::SIGKILL);
            }
            if running {
                libc::kill(pid, libc::SIGKILL);
            }
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
    if let Some(terminal) = spawn.terminal {
        // A foreground child needs Ctrl-C even when the dialog uses raw mode.
        // Subsequent mode changes belong to the child until it returns.
        terminal.enable_interrupts()?;
    }
    let mut child =
        tokio::process::Command::from(spawn.command(stdin, Stdio::piped(), Stdio::piped()))
            .kill_on_drop(true)
            .spawn()?;
    let pid = child.id().expect("child not yet reaped") as libc::pid_t;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let cancelled_token = cancel.unwrap_or_default();
    let mut watch = tokio::time::interval(FOREGROUND_WATCH);
    let result = {
        let completion =
            async { tokio::try_join!(child.wait(), read_pipe(stdout), read_pipe(stderr)) };
        tokio::pin!(completion);
        loop {
            tokio::select! {
                biased;
                _ = cancelled_token.cancelled() => break Err(cancelled()),
                result = &mut completion => break result,
                _ = watch.tick() => {
                    if let Some(terminal) = spawn.terminal {
                        terminal.observe(pid);
                    }
                }
            }
        }
    };
    let (status, stdout, stderr) = match result {
        Ok(result) => result,
        Err(error) => {
            spawn.kill(pid, child.id().is_some());
            let _ = child.wait().await;
            return Err(error);
        }
    };
    Ok((
        pid,
        status,
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

/// Read concurrently with the child wait; dropping the future closes the
/// pipe even if a descendant still holds its writing end.
async fn read_pipe<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes).await?;
    }
    Ok(bytes)
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
                spawn.kill(pid, true);
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
    modes: libc::termios,
    /// A dialog lifecycle change supersedes the captured step's saved modes.
    capture_raw: Option<bool>,
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
    /// The SIGCONT count already folded into `displaced_by`.
    continued: Cell<usize>,
}

impl Terminal {
    fn enable_interrupts(&self) -> io::Result<()> {
        let fd = self.tty.as_raw_fd();
        let mut modes = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut modes) } < 0 {
            return Err(io::Error::last_os_error());
        }
        modes.c_lflag |= libc::ISIG;
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &modes) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn claim(mode: ShellMode) -> Option<Terminal> {
        let tty = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .ok()?;
        // SAFETY: plain queries on a valid fd.
        let (group, foreground) = unsafe { (libc::getpgrp(), libc::tcgetpgrp(tty.as_raw_fd())) };
        // SAFETY: tcgetattr initialises the modes for a valid terminal fd.
        let mut modes = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(tty.as_raw_fd(), &mut modes) } == -1 {
            return None;
        }
        (foreground == group).then_some(Terminal {
            tty,
            group,
            modes,
            capture_raw: (mode == ShellMode::Capture)
                .then(|| crossterm::terminal::is_raw_mode_enabled().unwrap_or(false)),
            killed: Cell::new(None),
            observed: Cell::new(group),
            displaced_by: Cell::new(None),
            continued: Cell::new(CONTINUED.load(std::sync::atomic::Ordering::SeqCst)),
        })
    }

    fn foreground(&self) -> libc::pid_t {
        // SAFETY: a query on a valid fd.
        unsafe { libc::tcgetpgrp(self.tty.as_raw_fd()) }
    }

    /// Sample the foreground while `child` runs. A group that is neither
    /// ours nor the child's has taken the terminal (the shell after a
    /// suspend and `bg`); it keeps that standing when the child's exit hands
    /// the terminal back to us, and loses it only when the shell itself
    /// resumes us with the terminal (`fg`, seen as a SIGCONT while we are
    /// the foreground).
    fn observe(&self, child: libc::pid_t) {
        let foreground = self.foreground();
        let continued = CONTINUED.load(std::sync::atomic::Ordering::SeqCst);
        let resumed = continued != self.continued.get();
        self.continued.set(continued);
        if foreground <= 0 || (foreground == self.observed.get() && !resumed) {
            return;
        }
        self.observed.set(foreground);
        let ours = foreground == self.group || group_belongs_to_child(foreground, child);
        if !ours {
            self.displaced_by.set(Some(foreground));
        } else if resumed && foreground == self.group {
            self.displaced_by.set(None);
        }
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

impl Drop for Terminal {
    fn drop(&mut self) {
        // A shell that took the foreground during suspend/bg owns its modes.
        if self.foreground() != self.group {
            return;
        }
        let mut modes = self.modes;
        if let Some(raw) = self.capture_raw {
            if crossterm::terminal::is_raw_mode_enabled().unwrap_or(false) != raw {
                return;
            }
            if raw {
                // The dialog controls signal keys as its state changes,
                // including a cancellation before the child has finished.
                let mut current = unsafe { std::mem::zeroed() };
                if unsafe { libc::tcgetattr(self.tty.as_raw_fd(), &mut current) } == 0 {
                    modes.c_lflag = (modes.c_lflag & !libc::ISIG) | (current.c_lflag & libc::ISIG);
                }
            }
        }
        // SAFETY: the fd and saved termios remain valid for this guard.
        unsafe { libc::tcsetattr(self.tty.as_raw_fd(), libc::TCSANOW, &modes) };
    }
}

/// Stop ancestors before killing descendants so a shell cannot advance to
/// its next command or orphan children during cleanup. Signal individual
/// pids: descendants may share Wrap's group with unrelated jobs.
fn kill_descendants(child: libc::pid_t) {
    let mut tree = vec![child];
    let mut next = 0;
    while next < tree.len() {
        let pid = tree[next];
        // SAFETY: the root is an unreaped direct child; other pids were
        // discovered through their parent, never through a shared group.
        if unsafe { libc::kill(pid, libc::SIGSTOP) } == 0 {
            for descendant in children_of(pid) {
                if !tree.contains(&descendant) {
                    tree.push(descendant);
                }
            }
        }
        next += 1;
    }
    for pid in tree.into_iter().skip(1).rev() {
        // SAFETY: each pid belongs to the stopped child's descendant tree.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

#[cfg(target_os = "linux")]
fn children_of(parent: libc::pid_t) -> Vec<libc::pid_t> {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse().ok())
        .filter(|&pid| parent_of(pid) == Some(parent))
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn children_of(parent: libc::pid_t) -> Vec<libc::pid_t> {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid: libc::pid_t = fields.next()?.parse().ok()?;
            (ppid == parent).then_some(pid)
        })
        .collect()
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

/// Counts SIGCONTs while a captured child shares the terminal: the shell
/// sends one for both `bg` and `fg`, and the foreground at that moment says
/// which the user meant.
static CONTINUED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// The SIGCONT handler that was active before the scope, chained so a
/// dialog's own note of the continue is still taken.
static CHAINED_CONTINUE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

extern "C" fn note_continued(signal: libc::c_int) {
    use std::sync::atomic::Ordering;
    CONTINUED.fetch_add(1, Ordering::SeqCst);
    let previous = CHAINED_CONTINUE.load(Ordering::SeqCst);
    if previous != libc::SIG_DFL && previous != libc::SIG_IGN {
        // SAFETY: the value was a handler function pointer read from
        // sigaction; calling it is what the kernel would have done.
        let handler: extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(previous) };
        handler(signal);
    }
}

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
        let noting_continue = signals == JOB_CONTROL_SIGNALS;
        let all: Vec<libc::c_int> = if noting_continue {
            signals.iter().copied().chain([libc::SIGCONT]).collect()
        } else {
            signals.to_vec()
        };
        for signal in all {
            // SAFETY: sigaction fills `previous`; the new action is SIG_IGN
            // (or the continue note) with an empty mask.
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = if signal == libc::SIGCONT {
                note_continued as *const () as libc::sighandler_t
            } else {
                libc::SIG_IGN
            };
            action.sa_flags = libc::SA_RESTART;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(signal, &action, &mut previous) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            if signal == libc::SIGCONT {
                CHAINED_CONTINUE.store(previous.sa_sigaction, std::sync::atomic::Ordering::SeqCst);
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
