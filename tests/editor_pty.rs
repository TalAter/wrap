use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use tokio_util::sync::CancellationToken;
use wrap::{
    editor::{EditorMeta, ResolvedEditor, spawn_editor},
    home::WrapHome,
};

fn fake(root: &Path, body: &str) -> ResolvedEditor {
    let path = root.join("fake-editor");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    ResolvedEditor {
        path: path.to_string_lossy().into_owned(),
        key: "fake".into(),
        meta: EditorMeta {
            display_name: "Fake".into(),
            wait_flag: None,
            gui: false,
        },
    }
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("editor readiness timed out");
}

#[tokio::test]
async fn editor_pty_child() {
    if std::env::var("WRAP_EDITOR_PTY_CHILD").as_deref() != Ok("1") {
        return;
    }
    use std::os::fd::AsRawFd;
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let tty = fs::File::open("/dev/tty").unwrap();
    let fd = tty.as_raw_fd();
    let original = unsafe { libc::tcgetpgrp(fd) };
    let mut before: libc::termios = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::tcgetattr(fd, &mut before) }, 0);
    for cancel in [false, true] {
        let body = if cancel {
            "[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 5\nstty -echo\nprintf ready > \"$(dirname \"$1\")/ready\"\nexec sleep 2"
        } else {
            "[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 5\nstty -echo\nprintf EDITOR_CHROME\nprintf 'tty edit' > \"$1\""
        };
        let editor = fake(home.root(), body);
        let token = CancellationToken::new();
        let job = spawn_editor(&editor, "seed", &home, Some(token.clone()));
        let trigger = async {
            if cancel {
                wait_file(&home.resolve("cache/ready")).await;
                token.cancel();
            }
        };
        let (result, _) = tokio::join!(job, trigger);
        assert_eq!(
            result.unwrap().as_deref(),
            if cancel { None } else { Some("tty edit") }
        );
        assert_eq!(unsafe { libc::tcgetpgrp(fd) }, original);
        let mut after: libc::termios = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::tcgetattr(fd, &mut after) }, 0);
        assert_eq!(after.c_lflag, before.c_lflag);
    }
}

#[test]
fn terminal_editor_reopens_tty_preserves_stdout_and_restores_modes() {
    use std::{
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::process::CommandExt,
        },
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let (mut master, mut slave) = (0, 0);
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0
    );
    let mut master = unsafe { fs::File::from_raw_fd(master) };
    let slave = unsafe { fs::File::from_raw_fd(slave) };
    let fd = slave.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "editor_pty_child", "--nocapture"])
        .env("WRAP_EDITOR_PTY_CHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 || libc::ioctl(fd, libc::TIOCSCTTY, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    drop(command);
    drop(slave);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0; 1024];
        while let Ok(n) = master.read(&mut buffer) {
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..n]);
        }
        bytes
    });
    let start = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if start.elapsed() > Duration::from_secs(5) {
            child.kill().unwrap();
            panic!("PTY child timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("EDITOR_CHROME"));
    assert!(String::from_utf8_lossy(&reader.join().unwrap()).contains("EDITOR_CHROME"));
}
