//! Signals and the terminal: a dialog's signal scope must sit on top of the
//! chrome exit handlers (not under them), and the chrome handlers must put
//! the terminal back in cooked mode when they are the ones that fire. The
//! termios check re-runs this binary as a child on a pseudo-terminal.

use std::fs::File;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use wrap::tui::{SessionSignals, TerminalSession};

const CHILD_ENV: &str = "WRAP_TERMINAL_SIGNAL_CHILD";
const SUPERVISOR_ENV: &str = "WRAP_TERMINAL_SIGNAL_SUPERVISOR";
const TIMEOUT: Duration = Duration::from_secs(10);

fn sigint_handler() -> libc::sighandler_t {
    let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(libc::SIGINT, std::ptr::null(), &mut current) };
    current.sa_sigaction
}

#[test]
fn a_signal_scope_opens_over_the_exit_handlers_and_hands_back_to_them() {
    let scope = SessionSignals::open().unwrap();
    assert!(
        wrap::chrome::exit_handlers_installed(),
        "the scope must install the chrome handlers before saving the previous dispositions"
    );
    drop(scope);
    assert_ne!(
        sigint_handler(),
        libc::SIG_DFL,
        "dropping the scope restores the chrome handler, not the default"
    );
}

/// Child-mode body; a no-op unless spawned by `run_child`. Opens the
/// terminal without a signal scope so the chrome handler is the one that
/// answers the signal.
#[test]
fn terminal_signal_child() {
    if std::env::var(CHILD_ENV).is_err() {
        return;
    }
    assert_ne!(
        unsafe { libc::getsid(0) },
        unsafe { libc::getpid() },
        "a supervisor must own the controlling terminal until restoration is checked"
    );
    let _terminal = TerminalSession::open().expect("stderr is a pty");
    unsafe {
        libc::raise(libc::SIGINT);
    }
    std::thread::sleep(std::time::Duration::from_secs(5));
    panic!("signal handler did not exit the process");
}

fn termios_of(fd: libc::c_int) -> libc::termios {
    let mut attrs: libc::termios = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::tcgetattr(fd, &mut attrs) },
        0,
        "tcgetattr: {}",
        io::Error::last_os_error()
    );
    attrs
}

fn assert_restored(before: libc::termios, after: libc::termios) {
    // XNU's tty.c sets PENDIN when ICANON resumes; this is kernel input state.
    #[cfg(target_os = "macos")]
    let local_mask = !libc::PENDIN;
    #[cfg(not(target_os = "macos"))]
    let local_mask = !0;
    assert_eq!(
        after.c_lflag & local_mask,
        before.c_lflag & local_mask,
        "local flags (ICANON/ECHO) restored"
    );
    assert_eq!(after.c_iflag, before.c_iflag, "input flags restored");
    assert_eq!(after.c_oflag, before.c_oflag, "output flags restored");
    assert_eq!(after.c_cflag, before.c_cflag, "control flags restored");
    assert_eq!(after.c_cc, before.c_cc, "control characters restored");
    #[cfg(target_os = "linux")]
    assert_eq!(after.c_line, before.c_line, "line discipline restored");
    unsafe {
        assert_eq!(
            libc::cfgetispeed(&after),
            libc::cfgetispeed(&before),
            "input speed restored"
        );
        assert_eq!(
            libc::cfgetospeed(&after),
            libc::cfgetospeed(&before),
            "output speed restored"
        );
    }
}

struct ReapChild(Child);

impl Drop for ReapChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn wait_for_exit(child: &mut Child) -> io::Result<ExitStatus> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "PTY child did not exit",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct Supervisor {
    child: ReapChild,
    control: UnixStream,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // EOF asks the supervisor to kill and reap its child before it exits.
        let _ = self.control.shutdown(Shutdown::Both);
        let _ = wait_for_exit(&mut self.child.0);
    }
}

/// The session leader outlives the signal child: Darwin revokes a controlling
/// terminal on its leader's exit, even with a slave descriptor still open.
#[test]
fn terminal_signal_supervisor() {
    if std::env::var_os(SUPERVISOR_ENV).is_none() {
        return;
    }
    let mut control = UnixStream::from(
        unsafe { BorrowedFd::borrow_raw(libc::STDIN_FILENO) }
            .try_clone_to_owned()
            .unwrap(),
    );
    control.set_nonblocking(true).unwrap();
    let before = termios_of(libc::STDERR_FILENO);
    let input = unsafe { BorrowedFd::borrow_raw(libc::STDERR_FILENO) }
        .try_clone_to_owned()
        .unwrap();
    let mut child = ReapChild(
        child_command("terminal_signal_child")
            .env_remove(SUPERVISOR_ENV)
            .env(CHILD_ENV, "1")
            .stdin(Stdio::from(input))
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        assert!(Instant::now() < deadline, "signal child did not exit");
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        let mut byte = [0];
        match control.read(&mut byte) {
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            result => panic!("parent disconnected or sent an early acknowledgement: {result:?}"),
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_restored(before, termios_of(libc::STDERR_FILENO));
    let code = status.code().expect("exited via exit(), not a signal");
    control.set_nonblocking(false).unwrap();
    control.set_read_timeout(Some(TIMEOUT)).unwrap();
    control.set_write_timeout(Some(TIMEOUT)).unwrap();
    control.write_all(&code.to_ne_bytes()).unwrap();
    // The master remains open and drained before the session leader may exit.
    let mut ack = [0];
    control
        .read_exact(&mut ack)
        .expect("parent must drain the PTY");
    assert_eq!(ack, [1]);
}

fn child_command(test: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .stdout(Stdio::null());
    command
}

fn drain_master(master: &mut File, bytes: &mut Vec<u8>, deadline: Instant) {
    let mut buf = [0; 4096];
    loop {
        assert!(Instant::now() < deadline, "PTY output did not finish");
        match master.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
            Err(e) => panic!("read PTY: {e}"),
        }
    }
}

fn run_child() -> (String, i32) {
    let (mut master, mut slave) = (0, 0);
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, 0, "openpty: {}", io::Error::last_os_error());
    let mut master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
        assert_ne!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            -1
        );
    }
    let flags = unsafe { libc::fcntl(master.as_raw_fd(), libc::F_GETFL) };
    assert_ne!(flags, -1);
    assert_ne!(
        unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) },
        -1
    );
    let (control, peer) = UnixStream::pair().unwrap();
    control.set_nonblocking(true).unwrap();
    let mut command = child_command("terminal_signal_supervisor");
    command
        .env_remove(CHILD_ENV)
        .env(SUPERVISOR_ENV, "1")
        .stdin(Stdio::from(OwnedFd::from(peer)))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(libc::STDERR_FILENO, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut supervisor = Supervisor {
        child: ReapChild(command.spawn().unwrap()),
        control,
    };
    drop(command);
    let deadline = Instant::now() + TIMEOUT;
    let mut bytes = Vec::new();
    let mut report = [0; 4];
    let mut received = 0;
    while received < report.len() {
        drain_master(&mut master, &mut bytes, deadline);
        match supervisor.control.read(&mut report[received..]) {
            Ok(0) => {
                drain_master(&mut master, &mut bytes, deadline);
                panic!(
                    "supervisor exited without a report: {:?}",
                    String::from_utf8_lossy(&bytes)
                );
            }
            Ok(n) => received += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("read supervisor report: {e}"),
        }
    }
    // The report follows wait() and tcgetattr(), so all child writes are queued.
    drain_master(&mut master, &mut bytes, deadline);
    supervisor.control.write_all(&[1]).unwrap();
    assert!(
        wait_for_exit(&mut supervisor.child.0).unwrap().success(),
        "supervisor failed"
    );
    (
        String::from_utf8_lossy(&bytes).into_owned(),
        i32::from_ne_bytes(report),
    )
}

#[test]
fn sigint_answered_by_the_exit_handlers_leaves_cooked_mode_and_exits_130() {
    let (output, code) = run_child();
    assert_eq!(code, 130, "{output:?}");
    assert!(output.contains("\x1b[?1049h"), "{output:?}");
    assert!(
        output.rfind("\x1b[?1049l") > output.rfind("\x1b[?1049h"),
        "alternate screen left: {output:?}"
    );
}
