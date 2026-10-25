mod process_observation;

use process_observation::{is_alive, live_members_of_group};

use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use wrap::shell::{
    ChildStdin, ShellMode, choose_child_stdin, execute_with_shell, group_belongs_to_child,
    shell_from_env,
};

const SH: &str = "/bin/sh";

fn in_headless_subprocess(test: &str) -> bool {
    if std::env::var("WRAP_HEADLESS_SHELL_TEST").as_deref() == Ok(test) {
        assert!(File::open("/dev/tty").is_err());
        return true;
    }
    let home = tempfile::tempdir().unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture"])
        .env("WRAP_HEADLESS_SHELL_TEST", test)
        .env("HOME", home.path())
        .env("WRAP_HOME", home.path())
        .env_remove("ENV")
        .env_remove("BASH_ENV")
        .stdin(std::process::Stdio::null());
    // SAFETY: setsid is async-signal-safe and detaches the child from any tty.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

fn is_reaped(pid: i32) -> bool {
    // SAFETY: signal zero checks existence without delivering a signal.
    let result = unsafe { libc::kill(pid, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[test]
fn process_observation_finds_live_group_members_but_not_zombies_or_reaped_children() {
    struct ReapOnDrop(std::process::Child);
    impl Drop for ReapOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let mut child = ReapOnDrop(
        std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap(),
    );
    let pid = child.0.id() as i32;
    assert!(is_alive(pid), "a running child must be observable");
    assert!(!is_reaped(pid));
    assert_eq!(live_members_of_group(pid), [pid]);
    // SAFETY: getpgrp only queries this process's group.
    assert!(!live_members_of_group(unsafe { libc::getpgrp() }).contains(&pid));

    child.0.kill().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while is_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: signal zero queries the child without changing it.
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "child is not reaped yet");
    assert!(!is_alive(pid), "a zombie is not a live process");
    assert!(!is_reaped(pid), "a zombie still exists until reaped");
    assert!(live_members_of_group(pid).is_empty());

    child.0.wait().unwrap();
    assert!(!is_alive(pid), "a reaped child is absent");
    assert!(is_reaped(pid));
    assert!(live_members_of_group(pid).is_empty());
}

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

#[tokio::test]
async fn cancellation_after_shell_exit_ends_descendants_holding_either_pipe() {
    if !in_headless_subprocess("cancellation_after_shell_exit_ends_descendants_holding_either_pipe")
    {
        return;
    }
    let startup = tempfile::tempdir().unwrap();
    let bash = startup.path().join("bash-with-job-control");
    // Emulate interactive startup enabling job control after parsing +m.
    std::fs::write(
        &bash,
        "#!/bin/sh\nexec /bin/bash --noprofile --norc -ic 'set -m; eval \"$1\"' bash \"$3\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&bash, std::fs::Permissions::from_mode(0o700)).unwrap();
    for shell in [SH, "/bin/bash", bash.to_str().unwrap()] {
        cancellation_after_shell_exit(shell).await;
    }
}

async fn cancellation_after_shell_exit(shell: &str) {
    for redirect in [">/dev/null", "2>/dev/null"] {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let job_file = dir.path().join("job");
        let command = format!(
            "echo $$ > {}; sleep 4 {redirect} & echo $! > {}",
            pid_file.display(),
            job_file.display()
        );
        let token = CancellationToken::new();
        let cancel = token.clone();
        let cancellation = async {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let pid = std::fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|text| text.trim().parse::<i32>().ok());
                if pid.is_some_and(is_reaped) {
                    break;
                }
                assert!(Instant::now() < deadline, "direct shell was not reaped");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let started = Instant::now();
            cancel.cancel();
            started
        };
        let (result, cancelled_at) = tokio::join!(
            execute_with_shell(&command, shell, ShellMode::Capture, Some(token)),
            cancellation
        );
        assert!(
            cancelled_at.elapsed() < Duration::from_secs(1),
            "cancellation waited for a descendant to close {redirect}"
        );
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        let job: i32 = std::fs::read_to_string(&job_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while is_alive(job) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !is_alive(job),
            "{shell}: descendant {job} survived cancellation ({redirect})"
        );
    }
}

#[tokio::test]
async fn cancellation_ends_the_whole_group_of_a_headless_captured_child() {
    if !in_headless_subprocess("cancellation_ends_the_whole_group_of_a_headless_captured_child") {
        return;
    }
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

// --- foreground ownership -------------------------------------------------

/// A child shell with job control on, so its background job sits in a
/// process group of its own; returns the shell and that job's pid.
fn shell_with_job_group() -> (std::process::Child, libc::pid_t) {
    use std::io::Read;
    let mut shell = std::process::Command::new("/bin/bash")
        .args(["-c", "set -m; sleep 30 & echo $!; wait"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut line = String::new();
    let mut stdout = shell.stdout.take().unwrap();
    let mut byte = [0u8; 1];
    while stdout.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        line.push(byte[0] as char);
    }
    (shell, line.trim().parse().unwrap())
}

fn end(mut shell: std::process::Child, job: libc::pid_t) {
    // SAFETY: plain signal sends to processes this test started.
    unsafe {
        libc::killpg(job, libc::SIGKILL);
        libc::killpg(shell.id() as libc::pid_t, libc::SIGKILL);
    }
    let _ = shell.wait();
}

#[test]
fn a_group_belongs_to_the_child_when_it_is_the_childs_own_or_descends_from_it() {
    let (shell, job) = shell_with_job_group();
    let child = shell.id() as libc::pid_t;
    // SAFETY: a plain query.
    let job_group = unsafe { libc::getpgid(job) };
    assert_eq!(job_group, job, "bash did not give the job its own group");
    assert!(
        group_belongs_to_child(child, child),
        "the child's own group"
    );
    assert!(
        group_belongs_to_child(job_group, child),
        "a group led by the child's descendant"
    );
    end(shell, job);
}

#[test]
fn the_group_of_the_shell_that_started_us_never_belongs_to_a_child() {
    let (shell, job) = shell_with_job_group();
    let child = shell.id() as libc::pid_t;
    // SAFETY: plain queries.
    let parent_group = unsafe { libc::getpgid(libc::getppid()) };
    assert!(!group_belongs_to_child(parent_group, child));
    end(shell, job);
}

#[cfg(target_os = "linux")]
#[test]
fn a_sibling_childs_group_does_not_belong_to_another_child() {
    let (first, first_job) = shell_with_job_group();
    let (second, second_job) = shell_with_job_group();
    let (first_pid, second_pid) = (first.id() as libc::pid_t, second.id() as libc::pid_t);
    assert!(!group_belongs_to_child(second_pid, first_pid));
    assert!(!group_belongs_to_child(second_job, first_pid));
    assert!(group_belongs_to_child(second_job, second_pid));
    end(first, first_job);
    end(second, second_job);
}

#[test]
fn an_emptied_group_belongs_to_whoever_asks() {
    let mut gone = std::process::Command::new("/bin/sh")
        .args(["-c", "true"])
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = gone.id() as libc::pid_t;
    gone.wait().unwrap();
    let (shell, job) = shell_with_job_group();
    assert!(group_belongs_to_child(pid, shell.id() as libc::pid_t));
    end(shell, job);
}
