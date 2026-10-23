use std::collections::HashMap;
use std::fs::File;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use wrap::shell::{ChildStdin, ShellMode, choose_child_stdin, execute_with_shell, shell_from_env};

const SH: &str = "/bin/sh";

#[tokio::test]
async fn capture_mode_separates_stdout_and_stderr_and_reports_exit_code() {
    let ok = execute_with_shell("echo hello", SH, ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(ok.exit_code, 0);
    assert_eq!(ok.stdout, "hello\n");
    assert_eq!(ok.shell, SH);

    let both = execute_with_shell("echo out; echo err >&2", SH, ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(both.stdout, "out\n");
    assert!(both.stderr.contains("err\n"), "{:?}", both.stderr);

    let failed = execute_with_shell("exit 7", SH, ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(failed.exit_code, 7);
}

#[tokio::test]
async fn exec_ms_tracks_wall_clock() {
    let wall = Instant::now();
    let result = execute_with_shell("true", SH, ShellMode::Capture, None)
        .await
        .unwrap();
    let elapsed = wall.elapsed().as_millis() as u64;
    assert!(
        result.exec_ms <= elapsed + 50,
        "{} vs {elapsed}",
        result.exec_ms
    );
    let wall = Instant::now();
    let result = execute_with_shell("true", SH, ShellMode::Inherit, None)
        .await
        .unwrap();
    let elapsed = wall.elapsed().as_millis() as u64;
    assert_eq!(result.exit_code, 0);
    assert!(result.exec_ms <= elapsed + 50);
}

#[tokio::test]
async fn capture_mode_does_not_deadlock_on_large_output() {
    let result = execute_with_shell(
        "i=0; while [ $i -lt 3000 ]; do echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; echo 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' >&2; i=$((i+1)); done",
        SH,
        ShellMode::Capture,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout.lines().count(), 3000);
    assert!(result.stderr.lines().filter(|l| l.starts_with('y')).count() == 3000);
}

#[tokio::test]
async fn shell_from_env_falls_back_to_sh() {
    assert_eq!(shell_from_env(&HashMap::new()), "sh");
    let mut env = HashMap::new();
    env.insert("SHELL".to_string(), "".to_string());
    assert_eq!(shell_from_env(&env), "sh");
    env.insert("SHELL".to_string(), "/bin/zsh".to_string());
    assert_eq!(shell_from_env(&env), "/bin/zsh");
}

#[tokio::test]
async fn inherit_mode_reports_exit_codes_and_signal_deaths() {
    let result = execute_with_shell("exit 3", SH, ShellMode::Inherit, None)
        .await
        .unwrap();
    assert_eq!(result.exit_code, 3);
    assert!(result.stdout.is_empty() && result.stderr.is_empty());
    let killed = execute_with_shell("kill -KILL $$", SH, ShellMode::Inherit, None)
        .await
        .unwrap();
    assert_eq!(killed.exit_code, 137);
    let killed = execute_with_shell("kill -KILL $$", SH, ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(killed.exit_code, 137);
}

#[tokio::test]
async fn cancellation_kills_a_captured_child() {
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    });
    let start = Instant::now();
    let result = execute_with_shell("sleep 5", SH, ShellMode::Capture, Some(token)).await;
    assert!(start.elapsed() < Duration::from_millis(1500));
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
}

/// Live (non-zombie) pids whose process group is `pgid`, from /proc.
fn live_members_of_group(pgid: i32) -> Vec<i32> {
    let mut members = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // Fields after the parenthesised command: state, ppid, pgrp, ...
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() > 2 && fields[0] != "Z" && fields[2] == pgid.to_string() {
            members.push(pid);
        }
    }
    members
}

#[tokio::test]
async fn cancellation_ends_the_whole_group_of_a_headless_captured_child() {
    // Without a terminal the shell gets a process group of its own, so the
    // backgrounded grandchild must die with it instead of lingering.
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let grandchild_file = dir.path().join("grandchild");
    let command = format!(
        "echo $$ > {}; sh -c 'sleep 30 & echo $! > {}; wait'",
        pid_file.display(),
        grandchild_file.display()
    );
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        cancel.cancel();
    });
    let result = execute_with_shell(&command, SH, ShellMode::Capture, Some(token)).await;
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);

    let child_pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("the shell wrote its pid before the cancel")
        .trim()
        .parse()
        .unwrap();
    let grandchild: i32 = std::fs::read_to_string(&grandchild_file)
        .expect("the grandchild was started before the cancel")
        .trim()
        .parse()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut members = live_members_of_group(child_pid);
    while (!members.is_empty() || is_alive(grandchild)) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
        members = live_members_of_group(child_pid);
    }
    assert!(
        members.is_empty(),
        "processes still alive in the child's group: {members:?}"
    );
    assert!(!is_alive(grandchild), "the backgrounded sleep survived");
}

/// Whether `pid` still exists and is not a zombie.
fn is_alive(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            stat.rsplit_once(')')
                .map(|(_, rest)| rest.split_whitespace().next() != Some("Z"))
        })
        .unwrap_or(false)
}

#[tokio::test]
async fn cancellation_terminates_an_inherited_child() {
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    });
    let start = Instant::now();
    let result = execute_with_shell("sleep 5", SH, ShellMode::Inherit, Some(token)).await;
    assert!(start.elapsed() < Duration::from_millis(1500));
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
}

#[test]
fn child_stdin_prefers_inherit_then_dev_tty_then_null() {
    let mut opened = false;
    let choice = choose_child_stdin(true, || {
        opened = true;
        File::open("/dev/null")
    });
    assert!(matches!(choice, ChildStdin::Inherit));
    assert!(!opened);

    let choice = choose_child_stdin(false, || File::open("/dev/null"));
    assert!(matches!(choice, ChildStdin::Tty(_)));

    let choice = choose_child_stdin(false, || Err(std::io::Error::other("ENXIO")));
    assert!(matches!(choice, ChildStdin::Null));
}
