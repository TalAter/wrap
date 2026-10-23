//! Skills: deterministic bundles of read-only tasks that run before the first
//! LLM call and land in the transcript as probe turns, so the model starts
//! with the context it would otherwise spend a round discovering.

mod commit;
mod discovery;
mod run;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use regex::Regex;

use crate::home::WrapHome;

pub use commit::commit_skill;
pub use discovery::{PROBED_TOOLS, discovery_skill, list_cwd_files};
pub use run::{exec_task_in_shell, run_skills};

/// When a skill fires.
pub enum Trigger {
    Always,
    Match(Regex),
}

impl Trigger {
    pub fn matches(&self, prompt: &str) -> bool {
        match self {
            Trigger::Always => true,
            Trigger::Match(pattern) => pattern.is_match(prompt),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskResult {
    pub output: String,
    pub exit_code: i32,
}

type TaskFuture = Pin<Box<dyn Future<Output = Option<TaskResult>> + Send>>;
type TaskRun = Box<dyn Fn() -> TaskFuture + Send + Sync>;

/// One task of a skill. `command` is what the transcript shows; by default
/// it is what runs (under `sh -c`), but `run` can replace the execution —
/// for output computed in Rust or for a shell task with a post-filter.
/// Returning `None` is a misfire and drops the turn, like a non-zero exit.
pub struct SkillTask {
    pub command: String,
    pub run: Option<TaskRun>,
}

impl SkillTask {
    pub fn shell(command: impl Into<String>) -> SkillTask {
        SkillTask {
            command: command.into(),
            run: None,
        }
    }

    pub fn computed<F, Fut>(command: impl Into<String>, run: F) -> SkillTask
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<TaskResult>> + Send + 'static,
    {
        SkillTask {
            command: command.into(),
            run: Some(Box::new(move || Box::pin(run()))),
        }
    }
}

/// What tasks need from the invocation.
pub struct SkillContext {
    pub home: WrapHome,
    pub cwd: PathBuf,
    /// Budget for each probe's captured output.
    pub max_captured_output_chars: usize,
}

type TaskBuilder = Box<dyn Fn(&SkillContext) -> Vec<SkillTask> + Send + Sync>;

/// `tasks` is built at run time so dynamic skills (discovery re-reads the
/// watchlist) see current state.
pub struct Skill {
    pub name: String,
    pub trigger: Trigger,
    pub tasks: TaskBuilder,
}

impl Skill {
    pub fn new(
        name: impl Into<String>,
        trigger: Trigger,
        tasks: impl Fn(&SkillContext) -> Vec<SkillTask> + Send + Sync + 'static,
    ) -> Skill {
        Skill {
            name: name.into(),
            trigger,
            tasks: Box::new(tasks),
        }
    }
}

/// Bundled skills in firing order: discovery turns precede the rest.
pub fn bundled_skills() -> Vec<Skill> {
    vec![discovery_skill(), commit_skill()]
}
