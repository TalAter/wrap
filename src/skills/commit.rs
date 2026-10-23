use std::path::PathBuf;

use regex::Regex;

use super::{Skill, SkillContext, SkillTask, TaskResult, Trigger, exec_task_in_shell};

// Pager, external diff driver and color off, so a user's git config cannot
// hijack, hang or colorize the diff the model reads.
const DIFF_CMD: &str = "git --no-pager diff --no-ext-diff --no-color";

// A clean repo makes these exit 0 with no output; emitting "ran X, got
// nothing" would waste the round the skill saves and anchor the model on a
// misleading state, so empty output drops the probe.
fn git_probe(command: &str, cwd: PathBuf) -> SkillTask {
    let probe = command.to_string();
    SkillTask::computed(command, move || {
        let probe = probe.clone();
        let cwd = cwd.clone();
        async move {
            let result = exec_task_in_shell(&probe, &cwd).await?;
            (result.exit_code == 0 && !result.output.trim().is_empty()).then_some(result)
        }
    })
}

// `git diff` omits untracked files: a new file gets a one-line `??` in
// status and no content, so the model would commit the tracked changes and
// leave it behind. List untracked files (honouring .gitignore, expanding
// untracked dirs) and show each as an addition. `diff --no-index` exits 1
// when files differ, so the exit code is normalised to 0 and the probe drops
// on empty output instead. stderr is silenced so a non-repo yields nothing.
fn untracked_probe(cwd: PathBuf) -> SkillTask {
    let command = format!(
        "git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 -I{{}} {DIFF_CMD} --no-index -- /dev/null {{}} 2>/dev/null"
    );
    let probe = command.clone();
    SkillTask::computed(command, move || {
        let probe = probe.clone();
        let cwd = cwd.clone();
        async move {
            let result = exec_task_in_shell(&probe, &cwd).await?;
            (!result.output.trim().is_empty()).then_some(TaskResult {
                output: result.output,
                exit_code: 0,
            })
        }
    })
}

fn build_tasks(ctx: &SkillContext) -> Vec<SkillTask> {
    let cwd = &ctx.cwd;
    // Both diffs rather than `git diff HEAD`: the model must tell staged from
    // unstaged for partial-commit workflows.
    vec![
        // status has no --no-color flag; -c is the only lever.
        git_probe("git -c color.status=false status --short", cwd.clone()),
        git_probe(&format!("{DIFF_CMD} --cached"), cwd.clone()),
        git_probe(DIFF_CMD, cwd.clone()),
        untracked_probe(cwd.clone()),
    ]
}

pub fn commit_skill() -> Skill {
    Skill::new(
        "commit",
        Trigger::Match(Regex::new(r"(?i)\bcommit\b").expect("valid regex")),
        build_tasks,
    )
}
