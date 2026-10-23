//! Wrap's narration channel: the notification bus, chrome status lines,
//! verbose traces, the stderr spinner and the exit-teardown registry.
//! Everything here writes to stderr; stdout stays reserved for output.

use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, Once};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedSender;

use crate::ansi::{ERASE_LINE, HIDE_CURSOR, SHOW_CURSOR, dim};

// ── Notification bus ─────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notification {
    Chrome { text: String, icon: Option<String> },
    Verbose { line: String },
    StepOutput { text: String },
}

type Subscriber = (u64, UnboundedSender<Notification>);

static SUBSCRIBER: Mutex<Option<Subscriber>> = Mutex::new(None);
static NEXT_SUBSCRIPTION: AtomicU64 = AtomicU64::new(1);

/// Keeps a subscription alive; dropping it detaches the sink.
#[derive(Debug)]
pub struct SubscriptionGuard {
    id: u64,
}

impl Drop for SubscriptionGuard {
    fn drop(&mut self) {
        let mut current = lock(&SUBSCRIBER);
        if current.as_ref().is_some_and(|(id, _)| *id == self.id) {
            *current = None;
        }
    }
}

fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Route notifications to `sink` instead of stderr. One sink at a time: a
/// later subscription replaces the current one, and dropping the earlier
/// guard leaves the newer sink in place.
pub fn subscribe(sink: UnboundedSender<Notification>) -> SubscriptionGuard {
    let id = NEXT_SUBSCRIPTION.fetch_add(1, Ordering::Relaxed);
    *lock(&SUBSCRIBER) = Some((id, sink));
    SubscriptionGuard { id }
}

/// Hand `n` to the subscribed sink, or format it onto stderr when nobody is
/// listening. A sink whose receiver is gone swallows the notification.
pub fn emit(n: Notification) {
    let sink = lock(&SUBSCRIBER).as_ref().map(|(_, sink)| sink.clone());
    match sink {
        Some(sink) => {
            let _ = sink.send(n);
        }
        None => write_notification_to_stderr(&n),
    }
}

pub fn chrome(text: &str, icon: Option<&str>) {
    emit(Notification::Chrome {
        text: text.to_string(),
        icon: icon.map(str::to_string),
    });
}

/// Raw bytes straight to stderr, no newline: escapes and partial lines.
pub fn chrome_raw(bytes: &str) {
    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(bytes.as_bytes());
    let _ = stderr.flush();
}

/// The no-subscriber rendering: `icon text` lines, verbose lines verbatim.
/// Step output is dialog-only and has no stderr form.
pub fn write_notification_to_stderr(n: &Notification) {
    let mut stderr = io::stderr().lock();
    let _ = write_notification_to(&mut stderr, n);
    let _ = stderr.flush();
}

fn write_notification_to(w: &mut impl Write, n: &Notification) -> io::Result<()> {
    match n {
        Notification::Chrome { text, icon } => match icon {
            Some(icon) => writeln!(w, "{icon} {text}"),
            None => writeln!(w, "{text}"),
        },
        Notification::Verbose { line } => w.write_all(line.as_bytes()),
        Notification::StepOutput { .. } => Ok(()),
    }
}

// ── Verbose ──────────────────────────────────────────────────────

static VERBOSE_START: Mutex<Option<Instant>> = Mutex::new(None);

/// `» [+1.23s] ` measured from the first verbose line of the process.
fn verbose_prefix() -> String {
    let start = *lock(&VERBOSE_START).get_or_insert_with(Instant::now);
    dim(&format!("» [+{:.2}s] ", start.elapsed().as_secs_f64()))
}

pub fn verbose(enabled: bool, msg: &str) {
    verbose_highlight(enabled, msg, "");
}

/// Like [`verbose`], with `highlight` appended at normal brightness.
pub fn verbose_highlight(enabled: bool, msg: &str, highlight: &str) {
    if !enabled {
        return;
    }
    emit(Notification::Verbose {
        line: format!("{}{}{highlight}\n", verbose_prefix(), dim(msg)),
    });
}

/// Test-only: forget the first-call timestamp.
pub fn reset_verbose_timer() {
    *lock(&VERBOSE_START) = None;
}

// ── Spinner ──────────────────────────────────────────────────────

/// Two-cell braille frames, so the spinner occupies a fixed slot.
pub const SPINNER_FRAMES: [&str; 8] = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
pub const SPINNER_INTERVAL: Duration = Duration::from_millis(80);
pub const SPINNER_TEXT: &str = "thinking...";

type SharedWriter = Arc<Mutex<dyn Write + Send>>;

fn write_raw(writer: &SharedWriter, bytes: &str) {
    let mut w = lock(writer);
    let _ = w.write_all(bytes.as_bytes());
    let _ = w.flush();
}

/// A running stderr spinner. Dropping it (or calling [`Spinner::stop`])
/// erases the line and restores the cursor; both are idempotent.
pub struct Spinner {
    running: Option<Running>,
}

pub type SpinnerGuard = Spinner;

enum Running {
    Animated {
        stop: mpsc::Sender<()>,
        thread: Option<JoinHandle<()>>,
        writer: SharedWriter,
    },
    Static {
        writer: SharedWriter,
    },
}

impl Spinner {
    /// Start on `writer` when `is_tty`; otherwise an inert handle. With
    /// `no_animation` the text is shown once without a frame or cursor hide.
    pub fn start(text: &str, no_animation: bool, is_tty: bool, writer: SharedWriter) -> Spinner {
        if !is_tty {
            return Spinner { running: None };
        }
        if no_animation {
            write_raw(&writer, &format!("\r{text}"));
            return Spinner {
                running: Some(Running::Static { writer }),
            };
        }
        let lines: Vec<String> = SPINNER_FRAMES
            .iter()
            .map(|frame| format!("\r{frame} {text}"))
            .collect();
        write_raw(&writer, &format!("{HIDE_CURSOR}{}", lines[0]));
        let (stop, stopped) = mpsc::channel::<()>();
        let thread_writer = writer.clone();
        let thread = std::thread::spawn(move || {
            let mut index = 1;
            loop {
                match stopped.recv_timeout(SPINNER_INTERVAL) {
                    Err(RecvTimeoutError::Timeout) => {
                        write_raw(&thread_writer, &lines[index]);
                        index = (index + 1) % lines.len();
                    }
                    _ => return,
                }
            }
        });
        Spinner {
            running: Some(Running::Animated {
                stop,
                thread: Some(thread),
                writer,
            }),
        }
    }

    pub fn stop(&mut self) {
        match self.running.take() {
            Some(Running::Animated {
                stop,
                thread,
                writer,
            }) => {
                let _ = stop.send(());
                if let Some(thread) = thread {
                    let _ = thread.join();
                }
                write_raw(&writer, &format!("\r{ERASE_LINE}{SHOW_CURSOR}"));
            }
            Some(Running::Static { writer }) => write_raw(&writer, &format!("\r{ERASE_LINE}")),
            None => {}
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        self.stop();
    }
}

static CURSOR_TEARDOWN: std::sync::OnceLock<TeardownGuard> = std::sync::OnceLock::new();

/// Spinner on stderr, gated on stderr being a terminal. The first animated
/// spinner registers a cursor-restore teardown for the rest of the process.
pub fn start_chrome_spinner(text: &str, no_animation: bool) -> SpinnerGuard {
    let is_tty = io::stderr().is_terminal();
    if is_tty && !no_animation {
        CURSOR_TEARDOWN.get_or_init(|| register_exit_teardown(SHOW_CURSOR));
    }
    Spinner::start(
        text,
        no_animation,
        is_tty,
        Arc::new(Mutex::new(io::stderr())),
    )
}

// ── Exit teardown ────────────────────────────────────────────────

const MAX_TEARDOWNS: usize = 8;

static TEARDOWN_PTRS: [AtomicPtr<u8>; MAX_TEARDOWNS] =
    [const { AtomicPtr::new(std::ptr::null_mut()) }; MAX_TEARDOWNS];
static TEARDOWN_LENS: [AtomicUsize; MAX_TEARDOWNS] = [const { AtomicUsize::new(0) }; MAX_TEARDOWNS];
static STDERR_IS_TTY: AtomicBool = AtomicBool::new(false);
static INSTALL_HANDLERS: Once = Once::new();
/// Registration is serialized so a slot's length and pointer stay paired;
/// the handlers only read.
static REGISTER: Mutex<()> = Mutex::new(());

/// A registered teardown; dropping it withdraws the bytes.
#[derive(Debug)]
pub struct TeardownGuard {
    slot: Option<usize>,
}

impl Drop for TeardownGuard {
    fn drop(&mut self) {
        if let Some(slot) = self.slot {
            TEARDOWN_PTRS[slot].store(std::ptr::null_mut(), Ordering::Release);
        }
    }
}

/// Write `bytes` to stderr when the process exits normally or dies from
/// SIGINT/SIGTERM (which then re-exit with 130/143), provided stderr is a
/// terminal. Handlers install on the first registration. Registrations
/// beyond eight are dropped.
pub fn register_exit_teardown(bytes: &'static str) -> TeardownGuard {
    INSTALL_HANDLERS.call_once(install_exit_handlers);
    let _serial = lock(&REGISTER);
    let slot = (0..MAX_TEARDOWNS).find(|&i| TEARDOWN_PTRS[i].load(Ordering::Relaxed).is_null());
    if let Some(i) = slot {
        // The length lands before the pointer, so a handler that observes
        // the pointer also observes the length.
        TEARDOWN_LENS[i].store(bytes.len(), Ordering::Relaxed);
        TEARDOWN_PTRS[i].store(bytes.as_ptr().cast_mut(), Ordering::Release);
    }
    TeardownGuard { slot }
}

/// Currently registered teardown bytes, in slot order.
pub fn registered_teardowns() -> Vec<&'static str> {
    (0..MAX_TEARDOWNS)
        .filter_map(|i| {
            let ptr = TEARDOWN_PTRS[i].load(Ordering::Acquire);
            if ptr.is_null() {
                return None;
            }
            let len = TEARDOWN_LENS[i].load(Ordering::Relaxed);
            // Every published pointer came from a `&'static str`.
            let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
            std::str::from_utf8(bytes).ok()
        })
        .collect()
}

/// Async-signal-safe: only atomics and `write(2)`.
fn write_teardowns_to_fd(fd: libc::c_int, is_tty: bool) {
    if !is_tty {
        return;
    }
    for i in 0..MAX_TEARDOWNS {
        let ptr = TEARDOWN_PTRS[i].load(Ordering::Acquire);
        if ptr.is_null() {
            continue;
        }
        let len = TEARDOWN_LENS[i].load(Ordering::Relaxed);
        unsafe {
            libc::write(fd, ptr.cast(), len);
        }
    }
}

fn install_exit_handlers() {
    STDERR_IS_TTY.store(io::stderr().is_terminal(), Ordering::Relaxed);
    unsafe {
        libc::atexit(teardown_at_exit);
        for signal in [libc::SIGINT, libc::SIGTERM] {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = teardown_on_signal as extern "C" fn(libc::c_int) as usize;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
}

extern "C" fn teardown_at_exit() {
    write_teardowns_to_fd(libc::STDERR_FILENO, STDERR_IS_TTY.load(Ordering::Relaxed));
}

/// Signals skip `atexit`, so restore here and re-exit with the shell's
/// conventional code for the signal.
extern "C" fn teardown_on_signal(signal: libc::c_int) {
    write_teardowns_to_fd(libc::STDERR_FILENO, STDERR_IS_TTY.load(Ordering::Relaxed));
    let code = if signal == libc::SIGINT { 130 } else { 143 };
    unsafe { libc::_exit(code) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;
    use unicode_width::UnicodeWidthStr;

    /// Bus and verbose tests share process globals.
    static BUS: Mutex<()> = Mutex::new(());

    fn bus_lock() -> std::sync::MutexGuard<'static, ()> {
        BUS.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn render(n: &Notification) -> String {
        let mut buf = Vec::new();
        write_notification_to(&mut buf, n).unwrap();
        String::from_utf8(buf).unwrap()
    }

    #[test]
    fn stderr_rendering_prefixes_icons_and_drops_step_output() {
        assert_eq!(
            render(&Notification::Chrome {
                text: "done".into(),
                icon: Some("✓".into())
            }),
            "✓ done\n"
        );
        assert_eq!(
            render(&Notification::Chrome {
                text: "done\n".into(),
                icon: None
            }),
            "done\n\n"
        );
        assert_eq!(
            render(&Notification::Verbose {
                line: "\x1b[2mraw\x1b[0m\n".into()
            }),
            "\x1b[2mraw\x1b[0m\n"
        );
        assert_eq!(
            render(&Notification::StepOutput {
                text: "secret".into()
            }),
            ""
        );
    }

    #[test]
    fn subscribed_sink_receives_emits_until_its_guard_drops() {
        let _serial = bus_lock();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let guard = subscribe(tx);
        chrome("hello", Some("★"));
        assert_eq!(
            rx.try_recv().unwrap(),
            Notification::Chrome {
                text: "hello".into(),
                icon: Some("★".into())
            }
        );
        drop(guard);
        emit(Notification::StepOutput {
            text: "after".into(),
        });
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn latest_subscription_wins_and_outlives_an_older_guard() {
        let _serial = bus_lock();
        let (tx_a, mut rx_a) = tokio::sync::mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel();
        let guard_a = subscribe(tx_a);
        let guard_b = subscribe(tx_b);
        emit(Notification::StepOutput { text: "x".into() });
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_ok());
        drop(guard_a);
        emit(Notification::StepOutput { text: "y".into() });
        assert!(rx_b.try_recv().is_ok(), "dropping the stale guard keeps B");
        drop(rx_b);
        emit(Notification::StepOutput { text: "z".into() });
        drop(guard_b);
    }

    fn verbose_line(enabled: bool, msg: &str, highlight: Option<&str>) -> Option<String> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let _guard = subscribe(tx);
        match highlight {
            Some(h) => verbose_highlight(enabled, msg, h),
            None => verbose(enabled, msg),
        }
        match rx.try_recv() {
            Ok(Notification::Verbose { line }) => Some(line),
            Ok(other) => panic!("unexpected {other:?}"),
            Err(_) => None,
        }
    }

    fn elapsed_of(line: &str) -> f64 {
        let re = regex::Regex::new(r"» \[\+(\d+\.\d{2})s\] ").unwrap();
        re.captures(line).expect("prefix")[1].parse().unwrap()
    }

    #[test]
    fn verbose_lines_carry_a_dim_elapsed_prefix_from_the_first_call() {
        let _serial = bus_lock();
        assert_eq!(verbose_line(false, "nope", None), None);
        reset_verbose_timer();
        std::thread::sleep(Duration::from_millis(30));
        let first = verbose_line(true, "sending request", None).unwrap();
        assert!(first.starts_with(&dim("» [+0.00s] ")), "{first:?}");
        assert!(first.ends_with(&format!("{}\n", dim("sending request"))));
        std::thread::sleep(Duration::from_millis(30));
        let second = verbose_line(true, "response", Some("ls -la")).unwrap();
        assert!(elapsed_of(&second) > elapsed_of(&first));
        assert!(elapsed_of(&second) < 1.0, "seconds, not milliseconds");
        assert!(second.ends_with(&format!("{}ls -la\n", dim("response"))));
    }

    fn capture() -> (SharedWriter, Arc<Mutex<Vec<u8>>>) {
        struct Tee(Arc<Mutex<Vec<u8>>>);
        impl Write for Tee {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let sink = Arc::new(Mutex::new(Vec::new()));
        (Arc::new(Mutex::new(Tee(sink.clone()))), sink)
    }

    fn text_of(sink: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8(sink.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn spinner_frames_share_one_visual_width() {
        for frame in SPINNER_FRAMES {
            assert_eq!(frame.width(), 2, "{frame:?}");
        }
    }

    #[test]
    fn animated_spinner_hides_cursor_cycles_frames_and_erases_on_stop() {
        let (writer, sink) = capture();
        let mut spinner = Spinner::start(SPINNER_TEXT, false, true, writer);
        let first = text_of(&sink);
        assert_eq!(
            first,
            format!("{HIDE_CURSOR}\r{} {SPINNER_TEXT}", SPINNER_FRAMES[0])
        );
        std::thread::sleep(SPINNER_INTERVAL * 4);
        let during = text_of(&sink);
        assert!(during.contains(&format!("\r{} {SPINNER_TEXT}", SPINNER_FRAMES[1])));
        assert!(during.contains(&format!("\r{} {SPINNER_TEXT}", SPINNER_FRAMES[2])));
        spinner.stop();
        let stopped = text_of(&sink);
        assert!(stopped.ends_with(&format!("\r{ERASE_LINE}{SHOW_CURSOR}")));
        spinner.stop();
        drop(spinner);
        std::thread::sleep(SPINNER_INTERVAL * 3);
        assert_eq!(text_of(&sink), stopped, "nothing after stop");
        assert_eq!(stopped.matches(ERASE_LINE).count(), 1, "stop is idempotent");
    }

    #[test]
    fn no_animation_spinner_shows_text_once_and_erases_without_touching_cursor() {
        let (writer, sink) = capture();
        let spinner = Spinner::start("working", true, true, writer);
        std::thread::sleep(SPINNER_INTERVAL * 2);
        assert_eq!(text_of(&sink), "\rworking");
        drop(spinner);
        assert_eq!(text_of(&sink), format!("\rworking\r{ERASE_LINE}"));
    }

    #[test]
    fn spinner_is_silent_when_stderr_is_not_a_terminal() {
        let (writer, sink) = capture();
        let spinner = Spinner::start("working", false, false, writer);
        std::thread::sleep(SPINNER_INTERVAL * 2);
        drop(spinner);
        assert_eq!(text_of(&sink), "");
    }

    #[test]
    fn teardown_registry_tracks_live_guards_and_gates_on_tty() {
        let kitty = register_exit_teardown("\x1b[<u");
        let cursor = register_exit_teardown(SHOW_CURSOR);
        let listed = registered_teardowns();
        assert!(listed.contains(&"\x1b[<u") && listed.contains(&SHOW_CURSOR));
        drop(kitty);
        let listed = registered_teardowns();
        assert!(!listed.contains(&"\x1b[<u") && listed.contains(&SHOW_CURSOR));

        let (reader, writer) = io::pipe().unwrap();
        write_teardowns_to_fd(writer.as_raw_fd(), false);
        write_teardowns_to_fd(writer.as_raw_fd(), true);
        drop(writer);
        let mut out = String::new();
        io::Read::read_to_string(&mut &reader, &mut out).unwrap();
        assert!(out.contains(SHOW_CURSOR));
        assert!(!out.contains("\x1b[<u"));
        assert_eq!(
            out.matches(SHOW_CURSOR).count(),
            1,
            "non-tty pass wrote nothing"
        );
        drop(cursor);
    }
}
