//! One alternate-screen terminal session on stderr, the signal scope that
//! turns SIGINT/SIGTERM/SIGHUP into a cancellation flag while a dialog is up,
//! and the stdin drain that keeps buffered keystrokes from confirming.
//!
//! Interplay with the chrome exit-teardown registry: outside a dialog the
//! registry's SIGINT/SIGTERM handlers write their restore bytes and exit.
//! While a [`SessionSignals`] scope is open those handlers are superseded
//! (the scope records the previous dispositions and reinstates them on drop),
//! so a signal becomes a graceful cancel and the dialog's own teardown runs.
//! A [`TerminalSession`] additionally registers the screen-restore bytes with
//! the registry so an exit path that bypasses `Drop` still leaves the
//! terminal on its main screen.

use std::io::{self, IsTerminal, Write};
use std::sync::Once;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};

use crate::chrome::{TeardownGuard, register_exit_teardown};

/// Bytes that undo everything a session turned on, for the exit registry.
const RESTORE_BYTES: &str = "\x1b[<u\x1b[?2004l\x1b[?1049l\x1b[?25h";
/// Upper bound on queued events dropped by one drain.
const DRAIN_LIMIT: usize = 1024;

static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static ENHANCEMENT_ACTIVE: AtomicBool = AtomicBool::new(false);
static PANIC_HOOK: Once = Once::new();

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
        if let Err(error) = enable_raw_mode() {
            TERMINAL_ACTIVE.store(false, Ordering::Release);
            return Err(error);
        }
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

    pub fn size(&self) -> io::Result<ratatui::layout::Size> {
        self.terminal.size()
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
}

/// Drops every queued terminal event so nothing typed before this moment is
/// interpreted by what renders next. Bounded, and a no-op without an open
/// session. Returns how many events were discarded.
pub fn drain_pending_input() -> io::Result<usize> {
    if !TerminalSession::active() {
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
static SIGNAL_SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

extern "C" fn session_signal(signal: libc::c_int) {
    // Lock-free store only: nothing else is async-signal-safe here.
    SESSION_SIGNAL.store(signal, Ordering::Relaxed);
}

/// Scoped SIGINT/SIGTERM/SIGHUP dispositions that record the signal instead
/// of exiting. Dropping restores whatever handlers were installed before,
/// including the chrome exit-teardown handlers.
pub struct SessionSignals {
    previous: Vec<(libc::c_int, libc::sigaction)>,
}

impl SessionSignals {
    pub fn open() -> io::Result<Self> {
        SIGNAL_SESSION_ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| io::Error::other("a signal scope is already active"))?;
        let mut guard = Self {
            previous: Vec::with_capacity(3),
        };
        SESSION_SIGNAL.store(0, Ordering::Relaxed);
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            // SAFETY: zeroed sigaction values are fully initialized before
            // installation; the OS fills `previous`.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = session_signal as *const () as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            if unsafe { libc::sigaction(signal, &action, &mut previous) } == -1 {
                return Err(io::Error::last_os_error());
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }

    /// True once any of the three signals arrived during this scope.
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
    }
}
