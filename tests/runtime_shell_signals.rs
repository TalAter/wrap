//! Lives in its own binary: it reads the process-wide SIGINT disposition,
//! which other inherit-mode tests would be toggling concurrently.
use wrap::shell::{ShellMode, execute_with_shell};

const SH: &str = "/bin/sh";

fn current_sigint_handler() -> libc::sighandler_t {
    let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(libc::SIGINT, std::ptr::null(), &mut current) };
    current.sa_sigaction
}

// One test, so the disposition reads never race another inherit-mode run.
#[tokio::test]
async fn sigint_during_an_inherited_child_does_not_kill_wrap_and_the_child_starts_with_defaults() {
    let before = current_sigint_handler();
    let result = execute_with_shell("kill -INT $PPID; exit 4", SH, ShellMode::Inherit, None)
        .await
        .unwrap();
    assert_eq!(result.exit_code, 4);
    assert_eq!(current_sigint_handler(), before);

    // Wrap ignores both while the child runs; the child must not inherit
    // that, or Ctrl-C could never end the command. A grandchild sending
    // itself the signal dies by it (128 + signal) instead of shrugging.
    let interrupted = execute_with_shell("sh -c 'kill -INT $$'", SH, ShellMode::Inherit, None)
        .await
        .unwrap();
    assert_eq!(interrupted.exit_code, 130);
    let terminated = execute_with_shell("sh -c 'kill -TERM $$'", SH, ShellMode::Inherit, None)
        .await
        .unwrap();
    assert_eq!(terminated.exit_code, 143);
}
