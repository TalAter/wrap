use std::collections::HashSet;
use std::path::Path;
use std::time::SystemTime;

use crate::watchlist::{is_valid_tool_name, load_watchlist};

use super::{Skill, SkillContext, SkillTask, TaskResult, Trigger};

const OLDEST_COUNT: usize = 20;
const NEWEST_COUNT: usize = 30;

/// Tools `which`-checked on every run. JSON-backed so the eval optimizer can
/// fold the list into the prompt hash: changing it changes what the model
/// sees in the discovery output.
pub static PROBED_TOOLS: std::sync::LazyLock<Vec<&'static str>> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("probed-tools.json"))
        .expect("probed-tools.json is a string array")
});

struct Entry {
    name: String,
    is_dir: bool,
    modified: SystemTime,
}

/// The cwd listing sorted by mtime, directories suffixed with `/`. Beyond 50
/// entries only the oldest 20 and newest 30 are shown, with markers. `None`
/// for an empty or unreadable directory.
pub fn list_cwd_files(cwd: &Path) -> Option<String> {
    let entries = std::fs::read_dir(cwd).ok()?;
    let mut entries: Vec<Entry> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
                modified: meta.modified().ok()?,
            })
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_by_key(|e| e.modified);

    let total = entries.len();
    let capped = total > OLDEST_COUNT + NEWEST_COUNT;
    let selected: Vec<&Entry> = if capped {
        entries
            .iter()
            .take(OLDEST_COUNT)
            .chain(entries.iter().skip(total - NEWEST_COUNT))
            .collect()
    } else {
        entries.iter().collect()
    };
    let mut lines: Vec<String> = selected
        .iter()
        .map(|e| {
            if e.is_dir {
                format!("{}/", e.name)
            } else {
                e.name.clone()
            }
        })
        .collect();
    if capped {
        let omitted = total - (OLDEST_COUNT + NEWEST_COUNT);
        lines.insert(OLDEST_COUNT, format!("... ({omitted} entries omitted) ..."));
        lines.push(format!(
            "(showing {} of {total} entries)",
            OLDEST_COUNT + NEWEST_COUNT
        ));
    }
    Some(lines.join("\n"))
}

fn build_tasks(ctx: &SkillContext) -> Vec<SkillTask> {
    let cwd = ctx.cwd.clone();
    let mut tasks = vec![
        SkillTask::shell("pwd"),
        SkillTask::computed("ls", move || {
            let cwd = cwd.clone();
            async move {
                list_cwd_files(&cwd).map(|output| TaskResult {
                    output,
                    exit_code: 0,
                })
            }
        }),
    ];

    let mut seen = HashSet::new();
    let watchlist = load_watchlist(&ctx.home);
    let tools: Vec<&str> = PROBED_TOOLS
        .iter()
        .copied()
        .chain(watchlist.iter().map(|e| e.tool.as_str()))
        .filter(|t| is_valid_tool_name(t) && seen.insert(t.to_string()))
        .collect();
    if !tools.is_empty() {
        // `|| true`: a missing tool makes `which` exit 1, which would drop
        // the partial hit/miss listing this probe exists to capture.
        tasks.push(SkillTask::shell(format!(
            "which {} || true",
            tools.join(" ")
        )));
    }
    tasks
}

pub fn discovery_skill() -> Skill {
    Skill::new("discovery", Trigger::Always, build_tasks)
}
