//! One alternate-screen terminal session on stderr, the signal scope that
//! turns SIGINT/SIGQUIT/SIGTERM/SIGHUP into cancellation while a dialog is up
//! (and notes SIGCONT, so a dialog resumed with `fg` can take raw mode back),
//! and the stdin drain that keeps buffered keystrokes from confirming.
//!
//! Interplay with the chrome exit-teardown registry: outside a dialog the
//! registry's SIGINT/SIGTERM handlers write their restore bytes and exit.
//! Opening a [`SessionSignals`] scope installs those handlers first (so they
//! are what the scope saves) and then supersedes them; dropping the scope
//! reinstates them. A signal inside the scope therefore becomes a graceful
//! cancel and the dialog's own teardown runs. A [`TerminalSession`]
//! additionally registers the screen-restore bytes with the registry and the
//! cooked-mode `termios` restore as its hook, so an exit path that bypasses
//! `Drop` still leaves the terminal on its main screen in cooked mode.

use std::cell::{Cell, UnsafeCell};
use std::fs::File;
use std::io::{self, IsTerminal, Write};
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Mutex, Once};
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};

use crate::chrome::{
    TeardownGuard, install_exit_handlers, register_exit_teardown, set_exit_restore_hook,
};

/// Bytes that undo everything a session turned on, for the exit registry.
const RESTORE_BYTES: &str = "\x1b[<u\x1b[?2004l\x1b[?1049l\x1b[?25h";
/// Upper bound on queued events dropped by one drain.
const DRAIN_LIMIT: usize = 1024;

static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static ENHANCEMENT_ACTIVE: AtomicBool = AtomicBool::new(false);
static PANIC_HOOK: Once = Once::new();

/// The tty attributes from before raw mode, for the signal path.
struct CookedTermios(UnsafeCell<MaybeUninit<libc::termios>>);

// SAFETY: written only while `RAW_ACTIVE` is false, which is the only time
// the signal handler leaves it unread; sessions never overlap.
unsafe impl Sync for CookedTermios {}

static COOKED: CookedTermios = CookedTermios(UnsafeCell::new(MaybeUninit::uninit()));
static COOKED_SAVED: AtomicBool = AtomicBool::new(false);
static RAW_ACTIVE: AtomicBool = AtomicBool::new(false);

fn save_cooked_termios() {
    let mut attrs = MaybeUninit::<libc::termios>::uninit();
    // SAFETY: tcgetattr fills the struct on success; the slot is written
    // while no raw session is active, so the handler cannot be reading it.
    unsafe {
        if libc::tcgetattr(libc::STDERR_FILENO, attrs.as_mut_ptr()) == 0 {
            COOKED.0.get().write(attrs);
            COOKED_SAVED.store(true, Ordering::Release);
        }
    }
}

/// Async-signal-safe: atomic loads and `tcsetattr(2)`. A no-op unless raw
/// mode is on, so a normal exit after `Drop` changes nothing.
fn restore_cooked_termios() {
    if RAW_ACTIVE.load(Ordering::Acquire) && COOKED_SAVED.load(Ordering::Acquire) {
        // SAFETY: the slot was initialized before `COOKED_SAVED` was set.
        unsafe {
            libc::tcsetattr(
                libc::STDERR_FILENO,
                libc::TCSANOW,
                (*COOKED.0.get()).as_ptr(),
            );
        }
    }
}

/// The stderr alternate screen in raw mode with bracketed paste and a hidden
/// cursor. Opening fails when stderr is not a terminal. Released on drop,
/// by a panic (the hook restores before printing), and idempotently.
pub struct TerminalSession {
    pub(crate) terminal: ratatui::Terminal<ratatui::backend::CrosstermBackend<io::Stderr>>,
    _teardown: TeardownGuard,
}

impl TerminalSession {
    pub fn open() -> io::Result<Self> {
        if !io::stderr().is_terminal() {
            return Err(io::Error::other("stderr is not a terminal"));
        }
        if TERMINAL_ACTIVE.swap(true, Ordering::AcqRel) {
            return Err(io::Error::other("a terminal session is already open"));
        }
        PANIC_HOOK.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if TERMINAL_ACTIVE.swap(false, Ordering::AcqRel) {
                    restore_terminal();
                }
                previous(info);
            }));
        });
        let teardown = register_exit_teardown(RESTORE_BYTES);
        save_cooked_termios();
        set_exit_restore_hook(restore_cooked_termios);
        if let Err(error) = enable_raw_mode() {
            TERMINAL_ACTIVE.store(false, Ordering::Release);
            return Err(error);
        }
        RAW_ACTIVE.store(true, Ordering::Release);
        if let Err(error) = execute!(
            io::stderr(),
            EnterAlternateScreen,
            EnableBracketedPaste,
            crossterm::cursor::Hide
        ) {
            Self::release();
            return Err(error);
        }
        match ratatui::Terminal::new(ratatui::backend::CrosstermBackend::new(io::stderr())) {
            Ok(terminal) => {
                // Keystrokes typed while the model was thinking must not land
                // on the first frame.
                let _ = drain_pending_input();
                Ok(Self {
                    terminal,
                    _teardown: teardown,
                })
            }
            Err(error) => {
                Self::release();
                Err(error)
            }
        }
    }

    pub fn active() -> bool {
        TERMINAL_ACTIVE.load(Ordering::Acquire)
    }

    /// Kitty disambiguation while composing, so Shift+Enter and Ctrl+letter
    /// combos arrive with their modifier bits. Idempotent: pushes once on
    /// enable, pops once on disable.
    pub fn set_compose_keys(&mut self, enabled: bool) -> io::Result<()> {
        set_keyboard_enhancement(enabled)
    }

    /// Control whether the terminal turns control keys into signals. A
    /// terminal taken back by the user's shell is never changed.
    pub fn set_signal_keys(&self, enabled: bool) -> io::Result<()> {
        let mut modes = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(libc::STDERR_FILENO, &mut modes) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if (modes.c_lflag & libc::ISIG != 0) == enabled {
            return Ok(());
        }
        let foreground = unsafe { libc::tcgetpgrp(libc::STDERR_FILENO) };
        if foreground <= 0
            || !crate::shell::group_belongs_to_child(foreground, unsafe { libc::getpid() })
        {
            return Ok(());
        }
        if enabled {
            modes.c_lflag |= libc::ISIG;
        } else {
            modes.c_lflag &= !libc::ISIG;
        }
        if unsafe { libc::tcsetattr(libc::STDERR_FILENO, libc::TCSANOW, &modes) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn size(&self) -> io::Result<ratatui::layout::Size> {
        self.terminal.size()
    }

    /// Continued after a stop. Back in the foreground (`fg`) the shell has
    /// restored its own cooked modes meanwhile, so raw mode is re-entered
    /// and the next frame repaints everything the shell's prompt drew over.
    /// Continued in the background (`bg`) the terminal is the shell's and
    /// nothing is touched.
    pub fn resume(&mut self) -> io::Result<()> {
        // SAFETY: plain queries.
        if unsafe { libc::tcgetpgrp(libc::STDERR_FILENO) != libc::getpgrp() } {
            return Ok(());
        }
        // crossterm skips enabling raw mode it believes is still on.
        disable_raw_mode()?;
        enable_raw_mode()?;
        RAW_ACTIVE.store(true, Ordering::Release);
        execute!(
            io::stderr(),
            EnableBracketedPaste,
            crossterm::cursor::Hide,
            Clear(ClearType::All)
        )?;
        // With both of ratatui's buffers blank the next frame writes every
        // cell again, without the cursor query a clear would make.
        self.terminal.swap_buffers();
        Ok(())
    }

    fn release() {
        if TERMINAL_ACTIVE.swap(false, Ordering::AcqRel) {
            restore_terminal();
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        Self::release();
    }
}

fn set_keyboard_enhancement(enabled: bool) -> io::Result<()> {
    if enabled == ENHANCEMENT_ACTIVE.load(Ordering::Acquire) {
        return Ok(());
    }
    let mut stderr = io::stderr();
    if enabled {
        execute!(
            stderr,
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
    } else {
        execute!(stderr, PopKeyboardEnhancementFlags)?;
    }
    stderr.flush()?;
    ENHANCEMENT_ACTIVE.store(enabled, Ordering::Release);
    Ok(())
}

/// Whether the kitty disambiguation flags are currently pushed.
pub fn keyboard_enhancement_active() -> bool {
    ENHANCEMENT_ACTIVE.load(Ordering::Acquire)
}

/// Leaves the alternate screen and raw mode and pops any keyboard
/// enhancement. Safe to call more than once.
pub fn restore_terminal() {
    let mut stderr = io::stderr();
    if ENHANCEMENT_ACTIVE.swap(false, Ordering::AcqRel) {
        let _ = execute!(stderr, PopKeyboardEnhancementFlags);
    }
    let _ = execute!(
        stderr,
        DisableBracketedPaste,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    );
    let _ = disable_raw_mode();
    RAW_ACTIVE.store(false, Ordering::Release);
}

/// Bash reserves input from spawn; other shells reserve it once observed
/// outside our group. The reservation ends after exit is acknowledged and
/// the foreground returns. Shared-group shells allow dialog cancellation.
struct InputOwner {
    tty: File,
    child: Option<libc::pid_t>,
    handed_off: bool,
}

static CAPTURED_INPUT: Mutex<Option<InputOwner>> = Mutex::new(None);

pub(crate) fn dialog_owns_input() -> bool {
    let mut owner = CAPTURED_INPUT.lock().unwrap_or_else(|e| e.into_inner());
    let Some(owner) = owner.as_mut() else {
        return true;
    };
    // SAFETY: queries on a live tty descriptor and an unreaped child pid.
    let (group, foreground, child_group) = unsafe {
        (
            libc::getpgrp(),
            libc::tcgetpgrp(owner.tty.as_raw_fd()),
            owner.child.map_or(-1, |child| libc::getpgid(child)),
        )
    };
    owner.handed_off |= (child_group > 0 && child_group != group)
        || (foreground > 0
            && foreground != group
            && owner
                .child
                .is_some_and(|child| crate::shell::group_belongs_to_child(foreground, child)));
    !owner.handed_off && foreground == group
}

pub(crate) struct CapturedInput {
    active: Cell<bool>,
    child_exited: Cell<bool>,
}

impl CapturedInput {
    pub(crate) fn new(tty: Option<File>, child: libc::pid_t, expects_handoff: bool) -> Self {
        let active = tty.is_some();
        if let Some(tty) = tty {
            *CAPTURED_INPUT.lock().unwrap_or_else(|e| e.into_inner()) = Some(InputOwner {
                tty,
                child: Some(child),
                // Bash can take and return the tty, then rejoin our group,
                // entirely between ownership observations.
                handed_off: expects_handoff,
            });
        }
        Self {
            active: Cell::new(active),
            child_exited: Cell::new(false),
        }
    }

    pub(crate) fn child_exited(&self) {
        self.child_exited.set(true);
        if self.active.get()
            && let Some(owner) = CAPTURED_INPUT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
        {
            owner.child = None;
        }
    }

    pub(crate) fn child_has_exited(&self) -> bool {
        self.child_exited.get()
    }

    fn take(&self) -> Option<InputOwner> {
        if !self.active.replace(false) {
            return None;
        }
        CAPTURED_INPUT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    pub(crate) fn finish(&self) {
        if let Some(owner) = self.take()
            && owner.handed_off
            && TerminalSession::active()
            // SAFETY: a query on the guard's live tty descriptor.
            && unsafe { libc::tcgetpgrp(owner.tty.as_raw_fd()) == libc::getpgrp() }
        {
            // The child has exited or been killed and modes are restored. Discard
            // unread child input before reopening dialog input, independently
            // of pipe EOF. No live child's stdin is drained.
            // SAFETY: the tty is ours and the descriptor remains open.
            unsafe { libc::tcflush(owner.tty.as_raw_fd(), libc::TCIFLUSH) };
            let _ = drain_pending_input();
        }
    }
}

impl Drop for CapturedInput {
    fn drop(&mut self) {
        // Only explicit child completion or cancellation discards its input.
        self.take();
    }
}

/// Drops every queued terminal event so nothing typed before this moment is
/// interpreted by what renders next. Bounded, and a no-op without an open
/// session. Returns how many events were discarded.
pub fn drain_pending_input() -> io::Result<usize> {
    if !TerminalSession::active() || !dialog_owns_input() {
        return Ok(0);
    }
    let mut dropped = 0;
    // The /dev/tty event source skips zero-timeout polls entirely.
    while dropped < DRAIN_LIMIT && crossterm::event::poll(Duration::from_millis(1))? {
        crossterm::event::read()?;
        dropped += 1;
    }
    Ok(dropped)
}

static SESSION_SIGNAL: AtomicI32 = AtomicI32::new(0);
static SESSION_CONTINUED: AtomicBool = AtomicBool::new(false);
static SIGNAL_SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

extern "C" fn session_signal(signal: libc::c_int) {
    // Lock-free store only: nothing else is async-signal-safe here.
    SESSION_SIGNAL.store(signal, Ordering::Relaxed);
}

extern "C" fn session_continued(_signal: libc::c_int) {
    SESSION_CONTINUED.store(true, Ordering::Relaxed);
}

/// Scoped SIGINT/SIGQUIT/SIGTERM/SIGHUP dispositions that record the signal instead
/// of exiting, plus a SIGCONT note for the dialog to repaint after a stop.
/// Dropping restores the chrome exit-teardown handlers, which opening
/// installs first when nothing else has yet.
pub struct SessionSignals {
    previous: Vec<(libc::c_int, libc::sigaction)>,
}

impl SessionSignals {
    pub fn open() -> io::Result<Self> {
        install_exit_handlers();
        SIGNAL_SESSION_ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| io::Error::other("a signal scope is already active"))?;
        let mut guard = Self {
            previous: Vec::with_capacity(5),
        };
        SESSION_SIGNAL.store(0, Ordering::Relaxed);
        SESSION_CONTINUED.store(false, Ordering::Relaxed);
        for signal in [
            libc::SIGINT,
            libc::SIGQUIT,
            libc::SIGTERM,
            libc::SIGHUP,
            libc::SIGCONT,
        ] {
            // SAFETY: zeroed sigaction values are fully initialized before
            // installation; the OS fills `previous`.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            let handler = if signal == libc::SIGCONT {
                session_continued as *const ()
            } else {
                session_signal as *const ()
            };
            action.sa_sigaction = handler as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            if unsafe { libc::sigaction(signal, &action, &mut previous) } == -1 {
                return Err(io::Error::last_os_error());
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }

    /// True once a cancellation signal arrived during this scope.
    pub fn received(&self) -> bool {
        SESSION_SIGNAL.load(Ordering::Relaxed) != 0
    }

    /// The signal number that fired, if any.
    pub fn signal(&self) -> Option<i32> {
        match SESSION_SIGNAL.load(Ordering::Relaxed) {
            0 => None,
            n => Some(n),
        }
    }

    /// A shared foreground group's Ctrl-C interrupts its active step without
    /// turning subsequent dialog events into a session-wide cancellation.
    pub fn take_interrupt(&self) -> bool {
        SESSION_SIGNAL
            .compare_exchange(libc::SIGINT, 0, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    }

    /// True once per SIGCONT received during this scope.
    pub fn take_continued(&self) -> bool {
        SESSION_CONTINUED.swap(false, Ordering::Relaxed)
    }
}

impl Drop for SessionSignals {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.iter().rev() {
            // SAFETY: restores the exact disposition a successful
            // registration returned.
            unsafe { libc::sigaction(*signal, previous, std::ptr::null_mut()) };
        }
        SIGNAL_SESSION_ACTIVE.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_without_a_terminal_fails_and_leaves_nothing_active() {
        if io::stderr().is_terminal() {
            return;
        }
        assert!(TerminalSession::open().is_err());
        assert!(!TerminalSession::active());
        assert_eq!(drain_pending_input().unwrap(), 0);
    }

    #[test]
    fn signal_scope_records_a_signal_and_restores_previous_dispositions() {
        let scope = SessionSignals::open().unwrap();
        assert!(!scope.received());
        assert!(SessionSignals::open().is_err(), "scopes do not nest");
        unsafe { libc::raise(libc::SIGHUP) };
        assert!(scope.received());
        assert_eq!(scope.signal(), Some(libc::SIGHUP));
        drop(scope);
        let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
        unsafe { libc::sigaction(libc::SIGHUP, std::ptr::null(), &mut current) };
        assert_ne!(
            current.sa_sigaction,
            session_signal as *const () as libc::sighandler_t
        );
        let again = SessionSignals::open().unwrap();
        assert!(!again.received(), "a new scope starts clean");
        assert!(!again.take_continued());
        unsafe { libc::raise(libc::SIGCONT) };
        assert!(again.take_continued());
        assert!(!again.take_continued(), "a continue is noted once");
        assert!(!again.received(), "a continue is not a cancel");
    }
}
