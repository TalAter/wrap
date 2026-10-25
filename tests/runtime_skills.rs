mod process_observation;

use process_observation::{is_alive, live_members_of_group};

use std::fs::{self, File};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use wrap::home::WrapHome;
use wrap::logging::ProbeTurn;
use wrap::skills::{
    PROBED_TOOLS, Skill, SkillContext, SkillTask, TaskResult, Trigger, bundled_skills,
    commit_skill, discovery_skill, list_cwd_files, run_skills,
};

fn rig() -> (tempfile::TempDir, tempfile::TempDir, SkillContext) {
    let home_dir = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    let ctx = SkillContext {
        home: WrapHome::new(home_dir.path()),
        cwd: cwd.path().to_path_buf(),
        max_captured_output_chars: 200_000,
    };
    (home_dir, cwd, ctx)
}

fn ok(output: &str) -> Option<TaskResult> {
    Some(TaskResult {
        output: output.into(),
        exit_code: 0,
    })
}

fn computed(command: &str, output: &'static str, exit_code: i32) -> SkillTask {
    SkillTask::computed(command, move || async move {
        Some(TaskResult {
            output: output.into(),
            exit_code,
        })
    })
}

fn skill_with(
    name: &str,
    trigger: Trigger,
    build: impl Fn() -> Vec<SkillTask> + Send + Sync + 'static,
) -> Skill {
    Skill::new(name, trigger, move |_ctx| build())
}

fn commands(turns: &[ProbeTurn]) -> Vec<&str> {
    turns.iter().map(|t| t.command.as_str()).collect()
}

fn set_mtime(path: &Path, secs: u64) {
    let file = File::open(path).unwrap();
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap();
}

// --- triggers & emission --------------------------------------------------

#[tokio::test]
async fn a_timed_out_shell_task_takes_its_backgrounded_grandchildren_with_it() {
    let (_h, cwd, ctx) = rig();
    let pid_file = cwd.path().join("pid");
    let grandchild_file = cwd.path().join("grandchild");
    let command = format!(
        "echo $$ > {}; sleep 30 & echo $! > {}; sleep 5",
        pid_file.display(),
        grandchild_file.display()
    );
    let skill = skill_with("s", Trigger::Always, move || {
        vec![SkillTask::shell(command.clone())]
    });
    let start = Instant::now();
    let turns = run_skills(&[skill], "anything", &ctx).await;
    assert!(turns.is_empty(), "a timed-out task emits nothing");
    assert!(start.elapsed() < Duration::from_secs(3));

    let child_pid: i32 = fs::read_to_string(&pid_file)
        .expect("the probe wrote its pid before timing out")
        .trim()
        .parse()
        .unwrap();
    let grandchild: i32 = fs::read_to_string(&grandchild_file)
        .expect("the backgrounded sleep started before the timeout")
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
        "processes still alive in the probe's group: {members:?}"
    );
    assert!(!is_alive(grandchild), "the backgrounded sleep survived");
}

#[tokio::test]
async fn a_panicking_computed_task_is_a_misfire_and_the_rest_still_emit() {
    let (_h, _c, ctx) = rig();
    let skill = skill_with("s", Trigger::Always, || {
        vec![
            SkillTask::computed("boom", || async {
                if std::env::var_os("WRAP_SKILL_PANIC_NEVER_SET").is_none() {
                    panic!("computed task failed");
                }
                ok("unreachable")
            }),
            computed("echo fine", "fine", 0),
        ]
    });
    let turns = run_skills(&[skill], "anything", &ctx).await;
    assert_eq!(commands(&turns), ["echo fine"]);
}

#[tokio::test]
async fn triggers_gate_skills_and_matching_is_case_insensitive_when_the_regex_says_so() {
    let (_h, _c, ctx) = rig();
    let always = skill_with("s", Trigger::Always, || vec![computed("echo hi", "hi", 0)]);
    assert_eq!(run_skills(&[always], "anything", &ctx).await.len(), 1);

    let matching = skill_with(
        "s",
        Trigger::Match(regex::Regex::new("(?i)foo").unwrap()),
        || vec![computed("echo hi", "hi", 0)],
    );
    assert_eq!(run_skills(&[matching], "FOO bar", &ctx).await.len(), 1);

    let missing = skill_with(
        "s",
        Trigger::Match(regex::Regex::new("(?i)foo").unwrap()),
        || vec![computed("echo hi", "hi", 0)],
    );
    assert!(run_skills(&[missing], "baz", &ctx).await.is_empty());
}

#[tokio::test]
async fn a_successful_task_emits_one_probe_turn() {
    let (_h, _c, ctx) = rig();
    let s = skill_with("discovery", Trigger::Always, || {
        vec![computed("echo hi", "hi", 0)]
    });
    let turns = run_skills(&[s], "anything", &ctx).await;
    assert_eq!(
        turns,
        vec![ProbeTurn {
            skill: "discovery".into(),
            command: "echo hi".into(),
            output: "hi".into()
        }]
    );
}

#[tokio::test]
async fn misfiring_tasks_drop_silently() {
    let (_h, _c, ctx) = rig();
    let non_zero = skill_with("s", Trigger::Always, || {
        vec![computed("echo hi", "oops", 1)]
    });
    assert!(run_skills(&[non_zero], "x", &ctx).await.is_empty());
    let none = skill_with("s", Trigger::Always, || {
        vec![SkillTask::computed("echo hi", || async { None })]
    });
    assert!(run_skills(&[none], "x", &ctx).await.is_empty());
    let shell_false = skill_with("s", Trigger::Always, || vec![SkillTask::shell("false")]);
    assert!(run_skills(&[shell_false], "x", &ctx).await.is_empty());
}

#[tokio::test]
async fn shell_tasks_capture_stdout_and_append_stderr() {
    let (_h, _c, ctx) = rig();
    let s = skill_with("s", Trigger::Always, || {
        vec![SkillTask::shell("echo out && echo err >&2")]
    });
    let turns = run_skills(&[s], "x", &ctx).await;
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].output, "out\n\nerr\n");
    let only_out = skill_with("s", Trigger::Always, || vec![SkillTask::shell("echo hi")]);
    assert_eq!(run_skills(&[only_out], "x", &ctx).await[0].output, "hi\n");
}

#[tokio::test]
async fn shell_tasks_run_in_the_context_cwd() {
    let (_h, cwd, ctx) = rig();
    let s = skill_with("s", Trigger::Always, || vec![SkillTask::shell("pwd")]);
    let turns = run_skills(&[s], "x", &ctx).await;
    assert_eq!(
        fs::canonicalize(turns[0].output.trim()).unwrap(),
        fs::canonicalize(cwd.path()).unwrap()
    );
}

#[tokio::test]
async fn tasks_exceeding_the_one_second_cap_are_dropped() {
    let (_h, _c, ctx) = rig();
    let slow_shell = skill_with("s", Trigger::Always, || vec![SkillTask::shell("sleep 5")]);
    let start = Instant::now();
    assert!(run_skills(&[slow_shell], "x", &ctx).await.is_empty());
    assert!(start.elapsed() < Duration::from_millis(1500));

    let slow_computed = skill_with("s", Trigger::Always, || {
        vec![SkillTask::computed("slow", || async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            ok("late")
        })]
    });
    let start = Instant::now();
    assert!(run_skills(&[slow_computed], "x", &ctx).await.is_empty());
    assert!(start.elapsed() < Duration::from_millis(1500));
}

#[tokio::test]
async fn output_is_truncated_to_the_captured_output_budget() {
    let (_h, _c, mut ctx) = rig();
    ctx.max_captured_output_chars = 100;
    let s = skill_with("s", Trigger::Always, || {
        vec![SkillTask::shell(
            "i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done",
        )]
    });
    let turns = run_skills(&[s], "x", &ctx).await;
    assert!(turns[0].output.contains("…truncated"));
    assert!(turns[0].output.chars().count() < 300);
}

#[tokio::test]
async fn probes_keep_skill_order_then_task_order_skipping_non_matching_skills() {
    let (_h, _c, ctx) = rig();
    let a = skill_with("a", Trigger::Always, || {
        vec![computed("a1", "a1-out", 0), computed("a2", "a2-out", 0)]
    });
    let b = skill_with(
        "b",
        Trigger::Match(regex::Regex::new("nope").unwrap()),
        || vec![computed("b1", "b", 0)],
    );
    let c = skill_with("c", Trigger::Always, || vec![computed("c1", "c1-out", 0)]);
    let turns = run_skills(&[a, b, c], "anything", &ctx).await;
    assert_eq!(commands(&turns), vec!["a1", "a2", "c1"]);
    let skills: Vec<&str> = turns.iter().map(|t| t.skill.as_str()).collect();
    assert_eq!(skills, vec!["a", "a", "c"]);
}

// --- discovery ------------------------------------------------------------

#[tokio::test]
async fn discovery_emits_pwd_ls_and_which_probes() {
    let (_h, cwd, ctx) = rig();
    fs::write(cwd.path().join("alpha.txt"), "").unwrap();
    set_mtime(&cwd.path().join("alpha.txt"), 1_704_067_200);
    fs::write(cwd.path().join("beta.txt"), "").unwrap();
    set_mtime(&cwd.path().join("beta.txt"), 1_704_153_600);

    let turns = run_skills(&[discovery_skill()], "anything", &ctx).await;
    assert!(turns.iter().all(|t| t.skill == "discovery"));
    let pwd = turns
        .iter()
        .find(|t| t.command == "pwd")
        .expect("pwd probe");
    assert_eq!(
        fs::canonicalize(pwd.output.trim()).unwrap(),
        fs::canonicalize(cwd.path()).unwrap()
    );
    let ls = turns.iter().find(|t| t.command == "ls").expect("ls probe");
    assert_eq!(ls.output, "alpha.txt\nbeta.txt");
    let which = turns
        .iter()
        .find(|t| t.command.starts_with("which "))
        .expect("which probe");
    assert!(which.command.contains(" git "));
    assert!(which.command.ends_with(" || true"));
}

#[tokio::test]
async fn discovery_drops_ls_for_an_empty_cwd_but_keeps_which() {
    let (_h, _c, ctx) = rig();
    let turns = run_skills(&[discovery_skill()], "anything", &ctx).await;
    assert!(!turns.iter().any(|t| t.command == "ls"));
    assert!(turns.iter().any(|t| t.command.starts_with("which ")));
}

#[tokio::test]
async fn discovery_which_includes_valid_watchlist_tools_only() {
    let (_h, _c, ctx) = rig();
    ctx.home
        .write(
            "tool-watchlist.json",
            r#"[{"tool":"watchlist-extra","added":"2026-05-21"},{"tool":"; legit","added":"2026-05-21"},{"tool":"; echo injected","added":"2026-05-21"}]"#,
        )
        .unwrap();
    let turns = run_skills(&[discovery_skill()], "anything", &ctx).await;
    let which = turns
        .iter()
        .find(|t| t.command.starts_with("which "))
        .unwrap();
    assert!(which.command.contains("watchlist-extra"));
    assert!(!which.command.contains("legit"));
    assert!(!which.command.contains("injected"));
    assert_eq!(
        which.command.matches("git").count(),
        1,
        "no duplicate tool names"
    );
}

#[test]
fn probed_tools_cover_every_clipboard_tool() {
    for tool in wrap::clipboard::CLIPBOARD_TOOLS
        .iter()
        .chain(wrap::clipboard::CLIPBOARD_PASTE_TOOLS.iter())
    {
        assert!(
            PROBED_TOOLS.contains(tool),
            "{tool} missing from probed-tools.json"
        );
    }
}

#[test]
fn bundled_skills_run_discovery_before_commit() {
    let skills = bundled_skills();
    let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["discovery", "commit"]);
}

// --- list_cwd_files -------------------------------------------------------

fn populate(dir: &Path, count: usize) {
    for i in 0..count {
        let path = dir.join(format!("file-{i:03}.txt"));
        fs::write(&path, "").unwrap();
        set_mtime(&path, 1_704_067_200 + i as u64 * 86_400);
    }
}

#[test]
fn list_cwd_files_is_none_for_empty_or_missing_dirs() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(list_cwd_files(dir.path()), None);
    assert_eq!(list_cwd_files(Path::new("/nonexistent/path/xyz")), None);
}

#[test]
fn list_cwd_files_sorts_by_mtime_marks_dirs_and_includes_dotfiles() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    set_mtime(&dir.path().join("src"), 1_704_153_600);
    fs::write(dir.path().join("file.txt"), "").unwrap();
    set_mtime(&dir.path().join("file.txt"), 1_704_067_200);
    fs::write(dir.path().join(".gitignore"), "").unwrap();
    set_mtime(&dir.path().join(".gitignore"), 1_704_240_000);
    std::os::unix::fs::symlink("/nonexistent/target", dir.path().join("broken-link")).unwrap();
    let listing = list_cwd_files(dir.path()).unwrap();
    assert!(listing.starts_with("file.txt\nsrc/\n"), "{listing}");
    assert!(listing.contains(".gitignore"));
    assert!(listing.contains("broken-link"));
}

#[test]
fn list_cwd_files_caps_at_oldest_20_plus_newest_30() {
    let fifty = tempfile::tempdir().unwrap();
    populate(fifty.path(), 50);
    let lines: Vec<String> = list_cwd_files(fifty.path())
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    assert_eq!(lines.len(), 50);
    assert_eq!(lines[0], "file-000.txt");
    assert_eq!(lines[49], "file-049.txt");

    let many = tempfile::tempdir().unwrap();
    populate(many.path(), 73);
    let lines: Vec<String> = list_cwd_files(many.path())
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    assert_eq!(lines.len(), 52);
    assert_eq!(lines[0], "file-000.txt");
    assert_eq!(lines[19], "file-019.txt");
    assert_eq!(lines[20], "... (23 entries omitted) ...");
    assert_eq!(lines[21], "file-043.txt");
    assert_eq!(lines[50], "file-072.txt");
    assert_eq!(lines[51], "(showing 50 of 73 entries)");

    let edge = tempfile::tempdir().unwrap();
    populate(edge.path(), 51);
    let lines: Vec<String> = list_cwd_files(edge.path())
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    assert_eq!(lines.len(), 52);
    assert_eq!(lines[20], "... (1 entries omitted) ...");
    assert_eq!(lines[51], "(showing 50 of 51 entries)");
}

// --- commit ---------------------------------------------------------------

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn init_repo(cwd: &Path) {
    git(cwd, &["init", "-q"]);
    git(cwd, &["config", "user.email", "test@example.com"]);
    git(cwd, &["config", "user.name", "test"]);
    git(cwd, &["config", "commit.gpgsign", "false"]);
}

fn committed_base(cwd: &Path, content: &str) {
    fs::write(cwd.join("tracked.txt"), content).unwrap();
    git(cwd, &["add", "tracked.txt"]);
    git(cwd, &["commit", "-q", "-m", "init"]);
}

const STATUS: &str = "git -c color.status=false status --short";
const CACHED: &str = "git --no-pager diff --no-ext-diff --no-color --cached";
const UNSTAGED: &str = "git --no-pager diff --no-ext-diff --no-color";

#[test]
fn commit_trigger_matches_whole_word_case_insensitively() {
    let skill = commit_skill();
    let Trigger::Match(re) = &skill.trigger else {
        panic!("expected match trigger")
    };
    for ok in ["commit my changes", "Commit it", "COMMIT now", "pls commit"] {
        assert!(re.is_match(ok), "{ok}");
    }
    for no in [
        "list files",
        "her commitment is firm",
        "I committed yesterday",
        "uncommit",
    ] {
        assert!(!re.is_match(no), "{no}");
    }
}

#[tokio::test]
async fn commit_skill_is_silent_in_a_clean_repo_or_outside_git() {
    let (_h, cwd, ctx) = rig();
    init_repo(cwd.path());
    committed_base(cwd.path(), "x\n");
    assert!(
        run_skills(&[commit_skill()], "commit my changes", &ctx)
            .await
            .is_empty()
    );

    let (_h2, _c2, no_repo) = rig();
    assert!(
        run_skills(&[commit_skill()], "commit my changes", &no_repo)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn commit_skill_emits_status_and_both_diffs_in_order() {
    let (_h, cwd, ctx) = rig();
    init_repo(cwd.path());
    committed_base(cwd.path(), "base\n");
    fs::write(cwd.path().join("tracked.txt"), "base\nstaged-line\n").unwrap();
    git(cwd.path(), &["add", "tracked.txt"]);
    fs::write(
        cwd.path().join("tracked.txt"),
        "base\nstaged-line\nunstaged-line\n",
    )
    .unwrap();

    let turns = run_skills(&[commit_skill()], "commit my changes", &ctx).await;
    assert_eq!(commands(&turns), vec![STATUS, CACHED, UNSTAGED]);
    assert!(turns[0].output.contains("tracked.txt"));
    assert!(turns[1].output.contains("staged-line"));
    assert!(turns[2].output.contains("unstaged-line"));
    assert!(turns.iter().all(|t| t.skill == "commit"));
}

#[tokio::test]
async fn commit_skill_drops_the_empty_diff_side() {
    let (_h, cwd, ctx) = rig();
    init_repo(cwd.path());
    fs::write(cwd.path().join("hello.txt"), "hello\n").unwrap();
    git(cwd.path(), &["add", "hello.txt"]);
    let turns = run_skills(&[commit_skill()], "commit my changes", &ctx).await;
    assert_eq!(commands(&turns), vec![STATUS, CACHED]);

    let (_h2, cwd2, ctx2) = rig();
    init_repo(cwd2.path());
    committed_base(cwd2.path(), "x\n");
    fs::write(cwd2.path().join("tracked.txt"), "x\nmore\n").unwrap();
    let turns = run_skills(&[commit_skill()], "commit my changes", &ctx2).await;
    assert_eq!(commands(&turns), vec![STATUS, UNSTAGED]);
}

#[tokio::test]
async fn commit_skill_shows_untracked_files_as_additions() {
    let (_h, cwd, ctx) = rig();
    init_repo(cwd.path());
    committed_base(cwd.path(), "x\n");
    fs::create_dir(cwd.path().join("sub")).unwrap();
    fs::write(
        cwd.path().join("sub/new.ts"),
        "export const brandNew = 1;\n",
    )
    .unwrap();
    let turns = run_skills(&[commit_skill()], "commit my changes", &ctx).await;
    let untracked = turns
        .iter()
        .find(|t| t.command.contains("ls-files --others"))
        .expect("untracked probe");
    assert_eq!(
        untracked.command,
        "git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 -I{} git --no-pager diff --no-ext-diff --no-color --no-index -- /dev/null {} 2>/dev/null"
    );
    assert!(untracked.output.contains("sub/new.ts"));
    assert!(untracked.output.contains("brandNew"));
}

#[tokio::test]
async fn commit_skill_resists_hostile_git_config() {
    let (_h, cwd, ctx) = rig();
    init_repo(cwd.path());
    committed_base(cwd.path(), "base\n");
    fs::write(cwd.path().join("tracked.txt"), "base\nstaged-line\n").unwrap();
    git(cwd.path(), &["add", "tracked.txt"]);
    fs::write(
        cwd.path().join("tracked.txt"),
        "base\nstaged-line\nunstaged-line\n",
    )
    .unwrap();
    fs::write(cwd.path().join("untracked.txt"), "fresh-content\n").unwrap();
    git(
        cwd.path(),
        &["config", "diff.external", "echo EXTDIFFMARKER"],
    );
    git(cwd.path(), &["config", "color.ui", "always"]);

    let turns = run_skills(&[commit_skill()], "commit my changes", &ctx).await;
    let outputs: Vec<&str> = turns.iter().map(|t| t.output.as_str()).collect();
    let joined = outputs.join("\n---\n");
    assert!(!joined.contains("EXTDIFFMARKER"));
    assert!(!joined.contains('\x1b'));
    assert!(joined.contains("staged-line"));
    assert!(joined.contains("unstaged-line"));
    assert!(joined.contains("fresh-content"));
}

#[tokio::test]
async fn probe_deadline_includes_pipes_held_open_after_the_shell_exits() {
    let (_home, cwd, ctx) = rig();
    let skill = skill_with("s", Trigger::Always, || {
        vec![SkillTask::shell(
            "(sleep 2; echo survived > marker) & echo output; exit 0",
        )]
    });
    let start = Instant::now();
    let result =
        tokio::time::timeout(Duration::from_secs(4), run_skills(&[skill], "x", &ctx)).await;
    let elapsed = start.elapsed();
    tokio::time::sleep(Duration::from_millis(2200).saturating_sub(elapsed)).await;
    assert!(
        !cwd.path().join("marker").exists(),
        "probe descendant survived its deadline"
    );
    assert!(result.expect("probe hung after its deadline").is_empty());
    assert!(elapsed < Duration::from_millis(1800), "{elapsed:?}");
}
