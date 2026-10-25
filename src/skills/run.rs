use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::task::JoinHandle;

use crate::attached_input::truncate_middle;
use crate::logging::ProbeTurn;

use super::{Skill, SkillContext, SkillTask, TaskResult};

const TIMEOUT: Duration = Duration::from_secs(1);
// A computed task that itself shells out arms the shell timeout (which kills
// the child) and this outer one; the grace lets the inner one win the race.
const COMPUTED_TIMEOUT: Duration = Duration::from_millis(1100);

struct ProbeGroup(libc::pid_t);

impl Drop for ProbeGroup {
    fn drop(&mut self) {
        // SAFETY: probes start in their own process group; descendants share it.
        unsafe { libc::killpg(self.0, libc::SIGKILL) };
    }
}

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
    let group = ProbeGroup(child.id()? as libc::pid_t);
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    // The deadline includes EOF: descendants can retain pipes after sh exits.
    let result = tokio::time::timeout(TIMEOUT, async {
        tokio::try_join!(
            child.wait(),
            stdout.read_to_end(&mut stdout_bytes),
            stderr.read_to_end(&mut stderr_bytes),
        )
    })
    .await;
    drop(group);
    let status = match result {
        Ok(Ok((status, _, _))) => status,
        _ => {
            let _ = child.wait().await;
            return None;
        }
    };
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
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
