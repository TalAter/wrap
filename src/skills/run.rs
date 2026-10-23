use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::attached_input::truncate_middle;
use crate::logging::ProbeTurn;
use crate::shell::drain_pipe;

use super::{Skill, SkillContext, SkillTask, TaskResult};

const TIMEOUT: Duration = Duration::from_secs(1);
// A computed task that itself shells out arms the shell timeout (which kills
// the child) and this outer one; the grace lets the inner one win the race.
const COMPUTED_TIMEOUT: Duration = Duration::from_millis(1100);

/// Run a probe under `sh -c` in `cwd` with a one-second cap. Probes are
/// Wrap-authored POSIX, so they use `sh` rather than the user's `$SHELL`
/// (fish or csh would choke) and skip rc files. Stdout comes first, stderr
/// is appended when non-blank. `None` on spawn failure or timeout. The probe
/// has no terminal, so it runs in a process group of its own and a timeout
/// ends the whole group, not just `sh`.
pub async fn exec_task_in_shell(command: &str, cwd: &Path) -> Option<TaskResult> {
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let pid = child.id()? as libc::pid_t;
    // Pipes drain while waiting, so a chatty probe never deadlocks on a full
    // pipe and then trips the timeout as a false misfire.
    let stdout = drain_pipe(child.stdout.take());
    let stderr = drain_pipe(child.stderr.take());
    let status = match tokio::time::timeout(TIMEOUT, child.wait()).await {
        Ok(status) => status.ok()?,
        Err(_elapsed) => {
            // SAFETY: the child is spawned in its own group and not yet
            // reaped, so `pid` names that group and nothing else.
            unsafe { libc::killpg(pid, libc::SIGKILL) };
            let _ = child.wait().await;
            stdout.abort();
            stderr.abort();
            return None;
        }
    };
    let stdout = String::from_utf8_lossy(&stdout.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr.await.unwrap_or_default()).into_owned();
    let mut combined = stdout;
    if !stderr.trim().is_empty() {
        if !combined.trim().is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    Some(TaskResult {
        output: combined,
        exit_code: status.code().unwrap_or(1),
    })
}

/// Start a task on its own tokio task, so a computed task that panics is
/// contained there and reads as a misfire instead of ending the invocation.
fn spawn_task(task: &SkillTask, cwd: &Path) -> JoinHandle<Option<TaskResult>> {
    match &task.run {
        Some(run) => {
            let work = run();
            tokio::spawn(async move {
                tokio::time::timeout(COMPUTED_TIMEOUT, work)
                    .await
                    .ok()
                    .flatten()
            })
        }
        None => {
            let command = task.command.clone();
            let cwd = cwd.to_path_buf();
            tokio::spawn(async move { exec_task_in_shell(&command, &cwd).await })
        }
    }
}

/// Fire every skill whose trigger matches `prompt`. Tasks within a skill run
/// concurrently; turns keep skill order, then task declaration order. Tasks
/// that fail, time out, panic or return `None` emit nothing.
pub async fn run_skills(skills: &[Skill], prompt: &str, ctx: &SkillContext) -> Vec<ProbeTurn> {
    let mut turns = Vec::new();
    for skill in skills {
        if !skill.trigger.matches(prompt) {
            continue;
        }
        let tasks = (skill.tasks)(ctx);
        let handles: Vec<_> = tasks
            .iter()
            .map(|task| spawn_task(task, &ctx.cwd))
            .collect();
        for (task, handle) in tasks.iter().zip(handles) {
            let Some(result) = handle.await.ok().flatten() else {
                continue;
            };
            if result.exit_code != 0 {
                continue;
            }
            turns.push(ProbeTurn {
                skill: skill.name.clone(),
                command: task.command.clone(),
                output: truncate_middle(&result.output, ctx.max_captured_output_chars),
            });
        }
    }
    turns
}
