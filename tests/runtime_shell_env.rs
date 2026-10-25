//! Lives in its own binary: it sets `SHELL` for the whole process, which the
//! other shell tests must not observe.
use std::io::IsTerminal;
use std::os::unix::fs::PermissionsExt;

use wrap::shell::{ShellMode, execute_shell_command};

#[tokio::test]
async fn the_shell_comes_from_shell_env_with_the_interactive_no_monitor_argv_and_sh_as_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let fake_shell = dir.path().join("fakeshell");
    std::fs::write(&fake_shell, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
    std::fs::set_permissions(&fake_shell, std::fs::Permissions::from_mode(0o755)).unwrap();

    // SAFETY: this binary holds one test, so nothing else reads the
    // environment concurrently.
    unsafe { std::env::set_var("SHELL", &fake_shell) };
    let result = execute_shell_command("echo hi", ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(result.shell, fake_shell.to_string_lossy());
    let expected_command =
        if std::io::stdin().is_terminal() || std::fs::File::open("/dev/tty").is_ok() {
            "echo hi"
        } else {
            "set +m; echo hi"
        };
    assert_eq!(result.stdout, format!("+m\n-ic\n{expected_command}\n"));

    unsafe { std::env::set_var("SHELL", "") };
    let result = execute_shell_command("echo hi", ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(result.shell, "sh");
    assert_eq!(result.stdout, "hi\n");

    unsafe { std::env::remove_var("SHELL") };
    let result = execute_shell_command("echo hi", ShellMode::Capture, None)
        .await
        .unwrap();
    assert_eq!(result.shell, "sh");
    assert_eq!(result.exit_code, 0);
}
