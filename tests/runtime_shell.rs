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
async fn the_temp_dir_is_created_lazily_and_inherited_by_the_child() {
    let result = execute_with_shell("printf %s \"$WRAP_TEMP_DIR\"", SH, ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(!result.stdout.is_empty());
    assert!(std::path::Path::new(&result.stdout).is_dir());
    assert_eq!(std::env::var("WRAP_TEMP_DIR").unwrap(), result.stdout);
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
