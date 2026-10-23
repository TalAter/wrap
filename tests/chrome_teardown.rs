//! The exit-teardown registry must restore the terminal on every way out of
//! the process: normal exit, SIGINT and SIGTERM. Each scenario re-runs this
//! test binary as a child whose stderr is a pseudo-terminal, since the
//! teardown is gated on stderr being a TTY.

use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::process::{Command, Stdio};

use wrap::ansi::SHOW_CURSOR;
use wrap::chrome::register_exit_teardown;

const CHILD_ENV: &str = "WRAP_TEARDOWN_CHILD";
const KITTY_POP: &str = "\x1b[<u";

/// Child-mode body; a no-op unless spawned by `run_child`.
#[test]
fn teardown_child() {
    let Ok(mode) = std::env::var(CHILD_ENV) else {
        return;
    };
    let _cursor = register_exit_teardown(SHOW_CURSOR);
    let withdrawn = register_exit_teardown(KITTY_POP);
    drop(withdrawn);
    let _kept = register_exit_teardown("\x1b[?1049l");
    match mode.as_str() {
        "sigint" => unsafe {
            libc::raise(libc::SIGINT);
        },
        "sigterm" => unsafe {
            libc::raise(libc::SIGTERM);
        },
        _ => std::process::exit(7),
    }
    std::thread::sleep(std::time::Duration::from_secs(5));
    panic!("signal handler did not exit the process");
}

fn run_child(mode: &str) -> (String, i32) {
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
    let slave = unsafe { File::from_raw_fd(slave) };
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "teardown_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(slave))
        .spawn()
        .unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buf = [0u8; 1024];
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
    let output = reader.join().unwrap();
    (
        output,
        status.code().expect("exited via exit(), not a signal"),
    )
}

#[test]
fn normal_exit_writes_live_teardowns_to_the_terminal() {
    let (output, code) = run_child("exit");
    assert_eq!(code, 7);
    assert!(output.contains(SHOW_CURSOR), "{output:?}");
    assert!(output.contains("\x1b[?1049l"), "{output:?}");
    assert!(
        !output.contains(KITTY_POP),
        "withdrawn teardown ran: {output:?}"
    );
}

#[test]
fn sigint_restores_the_terminal_and_exits_130() {
    let (output, code) = run_child("sigint");
    assert_eq!(code, 130);
    assert!(output.contains(SHOW_CURSOR), "{output:?}");
    assert!(!output.contains(KITTY_POP), "{output:?}");
}

#[test]
fn sigterm_restores_the_terminal_and_exits_143() {
    let (output, code) = run_child("sigterm");
    assert_eq!(code, 143);
    assert!(output.contains(SHOW_CURSOR), "{output:?}");
}
