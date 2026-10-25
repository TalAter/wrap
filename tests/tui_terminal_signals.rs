//! Signals and the terminal: a dialog's signal scope must sit on top of the
//! chrome exit handlers (not under them), and the chrome handlers must put
//! the terminal back in cooked mode when they are the ones that fire. The
//! termios check re-runs this binary as a child on a pseudo-terminal.

use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

use wrap::tui::{SessionSignals, TerminalSession};

const CHILD_ENV: &str = "WRAP_TERMINAL_SIGNAL_CHILD";

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
    let _terminal = TerminalSession::open().expect("stderr is a pty");
    unsafe {
        libc::raise(libc::SIGINT);
    }
    std::thread::sleep(std::time::Duration::from_secs(5));
    panic!("signal handler did not exit the process");
}

fn termios_of(fd: libc::c_int) -> libc::termios {
    let mut attrs: libc::termios = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::tcgetattr(fd, &mut attrs) }, 0, "tcgetattr");
    attrs
}

fn run_child() -> (String, i32, libc::termios, libc::termios) {
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
    assert_eq!(rc, 0, "openpty");
    let master = unsafe { File::from_raw_fd(master) };
    unsafe {
        libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let before = termios_of(slave);
    let slave_err = unsafe { File::from_raw_fd(slave) };
    let slave_in = slave_err.try_clone().unwrap();
    let kept = slave_err.try_clone().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "terminal_signal_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, "1")
        .stdin(Stdio::from(slave_in))
        .stdout(Stdio::null())
        .stderr(Stdio::from(slave_err));
    // The pty becomes the child's controlling terminal, as a shell would
    // arrange, so `/dev/tty` resolves to it.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    // Releases the parent's copies of the slave so the master sees EOF.
    drop(command);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        let mut master = master;
        loop {
            match master.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => bytes.extend_from_slice(&buf[..n]),
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = child.wait().unwrap();
    let after = termios_of(kept.as_raw_fd());
    drop(kept);
    let output = reader.join().unwrap();
    (
        output,
        status.code().expect("exited via exit(), not a signal"),
        before,
        after,
    )
}

#[test]
fn sigint_answered_by_the_exit_handlers_leaves_cooked_mode_and_exits_130() {
    let (output, code, before, after) = run_child();
    assert_eq!(code, 130, "{output:?}");
    assert!(output.contains("\x1b[?1049h"), "{output:?}");
    assert!(
        output.rfind("\x1b[?1049l") > output.rfind("\x1b[?1049h"),
        "alternate screen left: {output:?}"
    );
    assert_eq!(
        after.c_lflag, before.c_lflag,
        "local flags (ICANON/ECHO) restored"
    );
    assert_eq!(after.c_iflag, before.c_iflag, "input flags restored");
    assert_eq!(after.c_oflag, before.c_oflag, "output flags restored");
    assert_eq!(after.c_cc, before.c_cc, "control characters restored");
}
