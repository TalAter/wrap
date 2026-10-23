use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::task::{Context, Poll};
use std::time::Duration;

use crate::attached_input::truncate_middle;
use crate::logging::ProbeTurn;

use super::{Skill, SkillContext, SkillTask, TaskResult};

const TIMEOUT: Duration = Duration::from_secs(1);
// A computed task that itself shells out arms the shell timeout (which kills
// the child) and this outer one; the grace lets the inner one win the race.
const COMPUTED_TIMEOUT: Duration = Duration::from_millis(1100);

/// Run a probe under `sh -c` in `cwd` with a one-second cap. Probes are
/// Wrap-authored POSIX, so they use `sh` rather than the user's `$SHELL`
/// (fish or csh would choke) and skip rc files. Stdout comes first, stderr
/// is appended when non-blank. `None` on spawn failure or timeout; the child
/// is killed on timeout.
pub async fn exec_task_in_shell(command: &str, cwd: &Path) -> Option<TaskResult> {
    let child = tokio::process::Command::new("sh")
        .args(["-c", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    // Pipes drain while waiting, so a chatty probe never deadlocks on a full
    // pipe and then trips the timeout as a false misfire.
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut combined = stdout.into_owned();
    if !stderr.trim().is_empty() {
        if !combined.trim().is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    Some(TaskResult {
        output: combined,
        exit_code: output.status.code().unwrap_or(1),
    })
}

async fn run_task(task: &SkillTask, cwd: &Path) -> Option<TaskResult> {
    match &task.run {
        Some(run) => tokio::time::timeout(COMPUTED_TIMEOUT, run())
            .await
            .ok()
            .flatten(),
        None => exec_task_in_shell(&task.command, cwd).await,
    }
}

/// Fire every skill whose trigger matches `prompt`. Tasks within a skill run
/// concurrently; turns keep skill order, then task declaration order. Tasks
/// that fail, time out or return `None` emit nothing.
pub async fn run_skills(skills: &[Skill], prompt: &str, ctx: &SkillContext) -> Vec<ProbeTurn> {
    let mut turns = Vec::new();
    for skill in skills {
        if !skill.trigger.matches(prompt) {
            continue;
        }
        let tasks = (skill.tasks)(ctx);
        let handles: Vec<_> = tasks.iter().map(|task| run_task(task, &ctx.cwd)).collect();
        let results = join_all(handles).await;
        for (task, result) in tasks.iter().zip(results) {
            let Some(result) = result else { continue };
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

/// Poll every future concurrently and return their outputs in input order.
async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    JoinAll {
        pending: futures.into_iter().map(|f| Some(Box::pin(f))).collect(),
        outputs: Vec::new(),
    }
    .await
}

struct JoinAll<F: Future> {
    pending: Vec<Option<Pin<Box<F>>>>,
    outputs: Vec<Option<F::Output>>,
}

impl<F: Future> Unpin for JoinAll<F> {}

impl<F: Future> Future for JoinAll<F> {
    type Output = Vec<F::Output>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if this.outputs.is_empty() {
            this.outputs = (0..this.pending.len()).map(|_| None).collect();
        }
        for (slot, output) in this.pending.iter_mut().zip(this.outputs.iter_mut()) {
            if let Some(fut) = slot
                && let Poll::Ready(value) = fut.as_mut().poll(cx)
            {
                *output = Some(value);
                *slot = None;
            }
        }
        if this.pending.iter().all(Option::is_none) {
            let outputs = std::mem::take(&mut this.outputs);
            return Poll::Ready(outputs.into_iter().flatten().collect());
        }
        Poll::Pending
    }
}
