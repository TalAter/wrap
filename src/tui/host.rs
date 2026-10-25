//! The terminal-backed [`DialogHost`]: the response dialog on the stderr
//! alternate screen, driven one frame per [`DialogHost::next_event`] call.
//!
//! The coordinator drops and recreates the `next_event` future after every
//! wake, so all progress (tick, dirty flag, queued events, the GUI editor in
//! flight) lives on the mounted dialog, never in the future.
//!
//! Signals: while the dialog is up SIGINT/SIGQUIT/SIGTERM/SIGHUP are recorded by a
//! [`SessionSignals`] scope instead of killing the process. A recorded signal
//! resolves `next_event` as [`AppEvent::KeyEsc`], and keeps doing so on every
//! later call, so the reducer backs out one state at a time (editing →
//! confirming → cancel) until the session exits and the terminal is restored
//! on the way out. The host remembers the signal
//! ([`TuiHost::signal_received`]) so the process can still exit with the
//! shell's code for it once the session has finalised. A SIGCONT (the shell's
//! `fg` after a stop) re-enters raw mode and repaints.
//! A shared foreground group's SIGINT during a step is consumed once: it
//! cancels that step and returns to confirmation without ending the session.

use std::collections::VecDeque;
use std::io::{self, IsTerminal};
use std::time::Duration;

use crossterm::event::{self, Event};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::ansi::color_level;
use crate::clipboard::{copy_to_clipboard, resolve_clipboard_tool_on_path};
use crate::editor::{ResolvedEditor, resolve_editor_from_env, spawn_editor};
use crate::home::WrapHome;
use crate::session::state::{AppEvent, AppState};
use crate::session::{DialogHost, HostFuture, run_terminal_editor};
use crate::theme::get_theme;
use crate::tui::drive::draw_frame;
use crate::tui::response_dialog::{
    ClipboardCopy, DialogSignal, EditorInfo, ResponseDialog, ResponseDialogOptions,
};
use crate::tui::terminal::{SessionSignals, TerminalSession, drain_pending_input};

/// Frame cadence; the dialog's spinner advances every third tick.
const TICK: Duration = Duration::from_millis(25);
/// How long each input poll waits; the /dev/tty source skips zero waits.
const INPUT_POLL: Duration = Duration::from_millis(1);

/// A GUI editor running on the compose buffer while the dialog stays up.
struct GuiEditor {
    task: JoinHandle<Option<String>>,
    cancel: CancellationToken,
}

struct Mounted {
    signals: SessionSignals,
    terminal: TerminalSession,
    dialog: ResponseDialog,
    dirty: bool,
    tick: usize,
    gui_editor: Option<GuiEditor>,
}

impl Mounted {
    fn frame(&mut self) -> io::Result<()> {
        self.terminal.set_compose_keys(self.dialog.compose_keys())?;
        if !matches!(self.dialog.state(), AppState::ExecutingStep { .. }) {
            self.terminal.set_signal_keys(false)?;
        }
        self.dialog.set_tick(self.tick);
        let dialog = &self.dialog;
        draw_frame(
            &mut self.terminal.terminal,
            &mut self.dirty,
            self.tick,
            dialog.animating(),
            |frame| dialog.render(frame),
        )
    }

    fn read_input(&mut self) -> io::Result<()> {
        loop {
            // While a confirmed step's job owns the terminal (interactive
            // bash hands it to each foreground job) the shell layer ignores
            // SIGTTIN, so reads fail with EIO instead of stopping Wrap;
            // keystrokes go to that job until it exits and the terminal is
            // reclaimed, so wait instead of ending the session.
            let ready = match event::poll(INPUT_POLL) {
                Ok(ready) => ready,
                Err(e) if e.raw_os_error() == Some(libc::EIO) => return Ok(()),
                Err(e) => return Err(e),
            };
            if !ready {
                return Ok(());
            }
            self.dirty = true;
            match event::read() {
                Ok(Event::Key(key)) => self.dialog.key(key),
                Ok(Event::Paste(text)) => self.dialog.paste(&text),
                Ok(_) => {}
                Err(e) if e.raw_os_error() == Some(libc::EIO) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }

    /// Hand a finished GUI editor's text back to the dialog.
    async fn settle_gui_editor(&mut self) {
        if self
            .gui_editor
            .as_ref()
            .is_some_and(|e| e.task.is_finished())
            && let Some(editor) = self.gui_editor.take()
        {
            // Abort-on-drop must not fire for a task that already finished.
            let mut editor = editor;
            let text = (&mut editor.task).await.ok().flatten();
            std::mem::forget(editor);
            self.dialog.gui_editor_done(text);
            self.dirty = true;
        }
    }

    fn start_gui_editors(&mut self, resolved: Option<&ResolvedEditor>, home: &WrapHome) {
        for signal in self.dialog.take_signals() {
            let DialogSignal::OpenGuiEditor { draft } = signal;
            let Some(resolved) = resolved.cloned() else {
                self.dialog.gui_editor_done(None);
                continue;
            };
            let cancel = CancellationToken::new();
            let token = cancel.clone();
            let home = home.clone();
            let task = tokio::spawn(async move {
                match spawn_editor(&resolved, &draft, &home, Some(token)).await {
                    Ok(text) => text,
                    Err(notice) => {
                        // Buffered by the router while the dialog is up and
                        // flushed to scrollback after it closes.
                        crate::chrome::chrome(&notice, None);
                        None
                    }
                }
            });
            self.gui_editor = Some(GuiEditor { task, cancel });
        }
    }
}

impl Drop for Mounted {
    /// Unmounting abandons a GUI editor still open: the wait stops, the
    /// editor itself keeps running.
    fn drop(&mut self) {
        if let Some(editor) = self.gui_editor.take() {
            editor.cancel.cancel();
            editor.task.abort();
        }
    }
}

/// The real host: one response dialog at a time on the stderr terminal.
pub struct TuiHost {
    home: WrapHome,
    env: std::collections::HashMap<String, String>,
    nerd_fonts: bool,
    no_animation: bool,
    editor: Option<ResolvedEditor>,
    clipboard: Option<&'static str>,
    mounted: Option<Mounted>,
    queued: VecDeque<AppEvent>,
    /// The signal that cancelled a mounted dialog, if one did.
    signal: Option<i32>,
}

impl TuiHost {
    /// Resolves the external editor and clipboard tool once for the process.
    pub fn new(
        home: WrapHome,
        env: std::collections::HashMap<String, String>,
        nerd_fonts: bool,
        no_animation: bool,
    ) -> Self {
        Self {
            home,
            env,
            nerd_fonts,
            no_animation,
            editor: resolve_editor_from_env(),
            clipboard: resolve_clipboard_tool_on_path(),
            mounted: None,
            queued: VecDeque::new(),
            signal: None,
        }
    }

    pub fn is_mounted(&self) -> bool {
        self.mounted.is_some()
    }

    /// The SIGINT/SIGTERM/SIGHUP number that interrupted a dialog during
    /// this host's lifetime; the session ends as a cancel, and the caller
    /// turns this into the `128 + signal` exit code.
    pub fn signal_received(&self) -> Option<i32> {
        self.signal
    }

    fn dialog_options(&self, continuation_prompt: Option<&str>) -> ResponseDialogOptions {
        let clipboard: Option<ClipboardCopy> = self
            .clipboard
            .map(|tool| Box::new(move |text: &str| copy_to_clipboard(text, tool)) as ClipboardCopy);
        ResponseDialogOptions {
            theme: get_theme(),
            nerd_fonts: self.nerd_fonts,
            no_animation: self.no_animation,
            color_level: color_level(io::stderr().is_terminal(), &self.env),
            editor: self.editor.as_ref().map(|e| EditorInfo {
                display_name: e.meta.display_name.clone(),
                gui: e.meta.gui,
            }),
            clipboard,
            continuation_prompt: continuation_prompt.map(str::to_string),
        }
    }
}

fn open_error(error: io::Error) -> String {
    format!("Could not open the confirmation dialog: {error}.")
}

impl DialogHost for TuiHost {
    fn stderr_is_tty(&self) -> bool {
        io::stderr().is_terminal()
    }

    fn stdin_is_tty(&self) -> bool {
        io::stdin().is_terminal()
    }

    fn mount(&mut self, state: &AppState, continuation_prompt: Option<&str>) -> Result<(), String> {
        if self.signal.is_some() {
            return Ok(());
        }
        let signals = SessionSignals::open().map_err(open_error)?;
        let terminal = TerminalSession::open().map_err(open_error)?;
        // Keystrokes typed while the model was thinking never confirm.
        let _ = drain_pending_input();
        let dialog = ResponseDialog::new(state, self.dialog_options(continuation_prompt));
        self.queued.clear();
        self.mounted = Some(Mounted {
            signals,
            terminal,
            dialog,
            dirty: true,
            tick: 0,
            gui_editor: None,
        });
        Ok(())
    }

    fn rerender(&mut self, state: &AppState) {
        let Some(mounted) = self.mounted.as_mut() else {
            return;
        };
        // Events produced for the previous state must not land on this one.
        if mounted.dialog.state().tag() != state.tag() {
            self.queued.clear();
        }
        mounted.dialog.sync(state);
        let _ = mounted
            .terminal
            .set_compose_keys(mounted.dialog.compose_keys());
        mounted.dirty = true;
    }

    fn unmount(&mut self) {
        if let Some(mounted) = &self.mounted
            && let Some(signal) = mounted.signals.signal()
        {
            self.signal = Some(signal);
        }
        // Dropping restores the main screen, raw mode and the signal
        // dispositions, and abandons a GUI editor still open.
        self.mounted = None;
        self.queued.clear();
    }

    fn next_event(&mut self) -> HostFuture<'_, Result<AppEvent, String>> {
        Box::pin(async move {
            loop {
                if let Some(event) = self.pending_signal() {
                    return Ok(event);
                }
                if let Some(event) = self.queued.pop_front() {
                    return Ok(event);
                }
                let Some(mounted) = self.mounted.as_mut() else {
                    return Err("The dialog is not open.".to_string());
                };
                if !TerminalSession::active() {
                    return Err("The terminal was released after a background failure.".to_string());
                }
                if mounted.signals.take_continued() {
                    mounted
                        .terminal
                        .resume()
                        .map_err(|e| format!("Could not resume the dialog: {e}."))?;
                    mounted.dirty = true;
                }
                mounted
                    .frame()
                    .map_err(|e| format!("Could not draw the dialog: {e}."))?;
                mounted
                    .read_input()
                    .map_err(|e| format!("Could not read from the terminal: {e}."))?;
                mounted.settle_gui_editor().await;
                mounted.start_gui_editors(self.editor.as_ref(), &self.home);
                let events = mounted.dialog.take_events();
                if !events.is_empty() {
                    mounted.dirty = true;
                    self.queued.extend(events);
                    continue;
                }
                if mounted.dialog.poll_timers() {
                    mounted.dirty = true;
                }
                mounted.tick = mounted.tick.wrapping_add(1);
                tokio::time::sleep(TICK).await;
            }
        })
    }

    fn pending_signal(&mut self) -> Option<AppEvent> {
        if self.mounted.is_none() {
            return self.signal.map(|_| AppEvent::KeyEsc);
        }
        let mounted = self.mounted.as_mut()?;
        let signal = mounted.signals.signal().or(self.signal)?;
        if !(signal == libc::SIGINT
            && matches!(mounted.dialog.state(), AppState::ExecutingStep { .. })
            && mounted.signals.take_interrupt())
        {
            self.signal = Some(signal);
        }
        Some(AppEvent::KeyEsc)
    }

    fn edit_in_editor(&mut self, draft: String) -> HostFuture<'_, Option<String>> {
        Box::pin(async move {
            if self.signal.is_some() {
                return None;
            }
            let signals = match SessionSignals::open() {
                Ok(signals) => signals,
                Err(error) => {
                    crate::chrome::chrome(&format!("Editor error: {error}"), None);
                    return None;
                }
            };
            let cancel = CancellationToken::new();
            let edit = run_terminal_editor(&draft, &self.home, cancel.clone());
            tokio::pin!(edit);
            loop {
                tokio::select! {
                    text = &mut edit => {
                        self.signal = signals.signal().or(self.signal);
                        return text;
                    }
                    _ = tokio::time::sleep(TICK) => {
                        if let Some(signal) = signals.signal() {
                            self.signal = Some(signal);
                            cancel.cancel();
                        }
                    }
                }
            }
        })
    }
}
