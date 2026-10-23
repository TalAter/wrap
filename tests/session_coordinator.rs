// The bus lock serializes tests that observe the process-global chrome bus;
// each test runs on a single thread, so holding it across awaits is safe.
#![allow(clippy::await_holding_lock)]
mod session_common;

use std::time::Duration;

use serde_json::json;
use session_common::{
    FakeHost, SessionRig, bus_lock, config, final_turn, llm_list, llm_single, turn_kinds,
};
use wrap::llm::Llm;
use wrap::logging::Turn;
use wrap::session::state::{ActionId, AppEvent, AppState, StateTag, StepSource};
use wrap::session::{ContinuationParent, SessionOptions, run_session};
use wrap::skills::{Skill, SkillTask, TaskResult, Trigger};

/// Sessions subscribe to the process-wide chrome bus, so they run one at a
/// time.
async fn run(
    prompt: &str,
    llm: &Llm,
    options: SessionOptions,
    host: &mut FakeHost,
) -> Result<i32, String> {
    let _bus = bus_lock();
    tokio::time::timeout(
        Duration::from_secs(10),
        run_session(prompt.to_string(), llm, options, host),
    )
    .await
    .expect("the session must finish")
}

fn is(tag: StateTag) -> impl Fn(&AppState) -> bool {
    move |s| s.tag() == tag
}

fn confirming(content: &'static str) -> impl Fn(&AppState) -> bool {
    move |s| s.tag() == StateTag::Confirming && s.response().is_some_and(|r| r.content == content)
}

fn assistant_contents(entry: &wrap::logging::LogEntry) -> Vec<String> {
    entry
        .turns
        .iter()
        .filter_map(|t| match t {
            Turn::Assistant {
                response: Some(r), ..
            } => Some(r.content.clone()),
            _ => None,
        })
        .collect()
}

// ── initial loop without a dialog ────────────────────────────────

#[tokio::test]
async fn a_low_risk_command_runs_without_a_dialog_and_propagates_its_exit_code() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"exit 3","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    let code = run("fail please", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(3));
    assert!(
        host.log.iter().all(|l| !l.starts_with("mount")),
        "{:?}",
        host.log
    );
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "error");
    assert_eq!(turn_kinds(&entry), ["user", "assistant", "final"]);
    assert_eq!(final_turn(&entry), Some(("exit 3", Some(3), "model")));
    assert_eq!(entry.input_source.as_deref(), Some("argv"));
    assert_eq!(
        entry.turns[0],
        Turn::User {
            text: "fail please".into()
        }
    );
}

#[tokio::test]
async fn an_answer_exits_zero_with_no_final_turn() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"reply","content":"the answer","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    let code = run("question?", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(0));
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "success");
    assert_eq!(turn_kinds(&entry), ["user", "assistant"]);
    assert!(host.mounted.is_none());
}

#[tokio::test]
async fn a_medium_command_without_a_tty_is_blocked_with_a_chrome_line() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"echo rm-a-fake","risk_level":"medium"}),
    ]);
    let mut host = FakeHost::no_tty();
    let code = run("delete it", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(1));
    assert!(
        host.stderr_text()
            .contains("Command requires confirmation (no TTY available): echo rm-a-fake\n"),
        "{}",
        host.stderr_text()
    );
    assert!(host.log.iter().all(|l| !l.starts_with("mount")));
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "blocked");
    assert_eq!(
        final_turn(&entry),
        Some(("echo rm-a-fake", None, "blocked"))
    );
}

#[tokio::test]
async fn yolo_runs_a_medium_command_without_a_tty() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"true","risk_level":"medium"}),
    ]);
    let mut host = FakeHost::no_tty();
    let code = run(
        "do it",
        &llm,
        rig.options(|o| o.config = config(|c| c.yolo = Some(true))),
        &mut host,
    )
    .await;
    assert_eq!(code, Ok(0));
    assert!(!host.stderr_text().contains("requires confirmation"));
    assert_eq!(
        final_turn(&rig.last_entry()),
        Some(("true", Some(0), "model"))
    );
}

#[tokio::test]
async fn exhaustion_exits_one_and_logs_max_rounds() {
    let rig = SessionRig::new();
    let step = json!({"type":"command","final":false,"content":"true","risk_level":"low"});
    let llm = llm_list(vec![step.clone(), step.clone(), step]);
    let mut host = FakeHost::tty();
    let code = run(
        "hmm",
        &llm,
        rig.options(|o| o.config = config(|c| c.max_rounds = Some(2))),
        &mut host,
    )
    .await;
    assert_eq!(code, Ok(1));
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "max_rounds");
    assert_eq!(
        turn_kinds(&entry),
        ["user", "assistant", "step", "assistant", "final"]
    );
    assert_eq!(final_turn(&entry), Some(("true", None, "exhausted")));
}

#[tokio::test]
async fn an_llm_failure_is_logged_then_returned_with_the_provider_label() {
    let rig = SessionRig::new();
    let llm = llm_single("ERROR:network down");
    let mut host = FakeHost::tty();
    let result = run("test", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(
        result,
        Err("LLM error (test / (default)): network down".into())
    );
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "error");
    assert_eq!(turn_kinds(&entry), ["user", "assistant", "final"]);
    match &entry.turns[1] {
        Turn::Assistant {
            response, attempts, ..
        } => {
            assert!(response.is_none());
            assert_eq!(attempts.len(), 1);
            assert_eq!(
                attempts[0].error.as_ref().unwrap().kind,
                wrap::logging::AttemptErrorKind::Provider
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(final_turn(&entry), Some(("", None, "error")));
}

#[tokio::test]
async fn a_parse_failure_is_retried_once_inside_the_same_assistant_turn() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!("not valid json"),
        json!({"type":"reply","content":"retried ok","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    assert_eq!(
        run("test", &llm, rig.options(|_| {}), &mut host).await,
        Ok(0)
    );
    let entry = rig.last_entry();
    match &entry.turns[1] {
        Turn::Assistant { attempts, .. } => {
            assert_eq!(attempts.len(), 2);
            assert_eq!(
                attempts[0].error.as_ref().unwrap().kind,
                wrap::logging::AttemptErrorKind::Parse
            );
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn an_inline_step_shows_its_explanation_but_never_its_output_on_stderr() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"echo OUTPUT_THAT_MUST_NOT_LEAK","risk_level":"low","explanation":"Find the secret"}),
        json!({"type":"reply","content":"done","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    assert_eq!(
        run("test", &llm, rig.options(|_| {}), &mut host).await,
        Ok(0)
    );
    let text = host.stderr_text();
    assert!(text.contains("🔍 Find the secret\n"), "{text}");
    assert!(!text.contains("OUTPUT_THAT_MUST_NOT_LEAK"), "{text}");
    // The output travels as its own notification kind, which only a mounted
    // dialog shows; it is never chrome.
    assert_eq!(host.step_outputs.len(), 1);
    assert!(
        host.step_outputs[0].starts_with("OUTPUT_THAT_MUST_NOT_LEAK\n"),
        "{:?}",
        host.step_outputs
    );
    let entry = rig.last_entry();
    assert_eq!(
        turn_kinds(&entry),
        ["user", "assistant", "step", "assistant"]
    );
}

#[tokio::test]
async fn the_request_opens_with_the_scaffold_prefix_and_then_the_framed_prompt() {
    // The scaffold's prefix messages (the few-shot pairs plus separator,
    // when the embedded prompt carries any) enter the conversation as real
    // messages ahead of the first framed user turn, under the scaffold's
    // system text.
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"reply","content":"done","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    let options = rig.options(|o| {
        o.config = session_common::config(|c| c.log_traces = Some(true));
    });
    assert_eq!(run("list files", &llm, options, &mut host).await, Ok(0));
    let entry = rig.last_entry();
    let assistant_index = entry
        .turns
        .iter()
        .position(|t| matches!(t, Turn::Assistant { .. }))
        .unwrap();
    let trace: serde_json::Value = serde_json::from_str(
        &rig.home
            .read(&format!("logs/traces/{}.json", entry.id))
            .unwrap()
            .expect("trace sidecar"),
    )
    .unwrap();
    let request = &trace["turn_attempts"][assistant_index.to_string()][0]["request"];
    let messages = request["messages"].as_array().unwrap();

    let scaffold = wrap::prompt::assemble_prompt_scaffold(&wrap::prompt::QueryContext {
        cwd: "/tmp".into(),
        piped: true,
        ..Default::default()
    });
    assert_eq!(request["system"], scaffold.system);
    let prefix = scaffold.prefix_messages;
    assert_eq!(
        prefix.len(),
        2 * wrap::prompt::optimized().few_shot_examples.len()
            + usize::from(!wrap::prompt::optimized().few_shot_examples.is_empty())
    );
    for (i, expected) in prefix.iter().enumerate() {
        assert_eq!(messages[i], serde_json::to_value(expected).unwrap());
    }
    let framed = &messages[prefix.len()];
    assert_eq!(framed["role"], "user");
    assert!(
        framed["content"].as_str().unwrap().contains("list files"),
        "{framed}"
    );
}

#[tokio::test]
async fn skills_emit_probe_turns_ahead_of_the_user_prompt() {
    let rig = SessionRig::new();
    let sentinel = Skill::new("sentinel", Trigger::Always, |_| {
        vec![SkillTask::computed("echo sentinel", || async {
            Some(TaskResult {
                output: "SENTINEL_OUT".into(),
                exit_code: 0,
            })
        })]
    });
    let llm = llm_list(vec![
        json!({"type":"reply","content":"ok","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    let code = run(
        "hello",
        &llm,
        rig.options(|o| o.skills = Some(vec![sentinel])),
        &mut host,
    )
    .await;
    assert_eq!(code, Ok(0));
    let entry = rig.last_entry();
    assert_eq!(turn_kinds(&entry), ["probe", "user", "assistant"]);
    assert_eq!(
        entry.turns[0],
        Turn::Probe {
            skill: "sentinel".into(),
            command: "echo sentinel".into(),
            output: "SENTINEL_OUT".into(),
        }
    );
}

// ── dialog paths ─────────────────────────────────────────────────

#[tokio::test]
async fn a_medium_command_mounts_the_dialog_and_runs_on_confirm() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"exit 2","risk_level":"medium"}),
    ]);
    let mut host = FakeHost::tty().on(is(StateTag::Confirming), AppEvent::KeyAction(ActionId::Run));
    let code = run("do it", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(2));
    assert_eq!(host.log, ["mount:Confirming", "unmount"]);
    assert_eq!(
        final_turn(&rig.last_entry()),
        Some(("exit 2", Some(2), "model"))
    );
}

#[tokio::test]
async fn esc_in_confirming_cancels_with_exit_zero() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"echo rm-fake","risk_level":"high","_scratchpad":"careful"}),
    ]);
    let mut host = FakeHost::tty().on(is(StateTag::Confirming), AppEvent::KeyEsc);
    let code = run("danger", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(0));
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "cancelled");
    assert_eq!(
        final_turn(&entry),
        Some(("echo rm-fake", None, "cancelled"))
    );
    assert!(host.mounted.is_none());
}

#[tokio::test]
async fn an_edited_command_runs_as_a_user_override() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"exit 1","risk_level":"medium"}),
    ]);
    let mut host = FakeHost::tty()
        .on(
            is(StateTag::Confirming),
            AppEvent::KeyAction(ActionId::Edit),
        )
        .on(
            |s| s.tag() == StateTag::Editing && s.draft() == Some("exit 1"),
            AppEvent::SubmitEdit {
                text: "exit 4".into(),
            },
        );
    let code = run("edit me", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(4));
    let entry = rig.last_entry();
    assert_eq!(
        final_turn(&entry),
        Some(("exit 4", Some(4), "user_override"))
    );
    assert_eq!(assistant_contents(&entry), ["exit 1"]);
}

#[tokio::test]
async fn a_follow_up_appends_a_user_turn_and_keeps_even_a_low_risk_result_in_the_dialog() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"echo a","risk_level":"medium"}),
        json!({"type":"command","content":"true","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty()
        .on(
            confirming("echo a"),
            AppEvent::KeyAction(ActionId::Followup),
        )
        .on(
            is(StateTag::ComposingFollowup),
            AppEvent::SubmitFollowup {
                text: "be safer".into(),
            },
        )
        .on(confirming("true"), AppEvent::KeyAction(ActionId::Run));
    let code = run("start", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(0));
    assert_eq!(host.remaining_script(), 0);
    let entry = rig.last_entry();
    assert_eq!(
        turn_kinds(&entry),
        ["user", "assistant", "user", "assistant", "final"]
    );
    assert_eq!(
        entry.turns[2],
        Turn::User {
            text: "be safer".into()
        }
    );
    assert_eq!(final_turn(&entry), Some(("true", Some(0), "model")));
    // The dialog stayed mounted across the follow-up.
    assert_eq!(host.log, ["mount:Confirming", "unmount"]);
    assert!(
        host.shown
            .iter()
            .any(|s| s.tag() == StateTag::ProcessingFollowup)
    );
}

#[tokio::test]
async fn esc_during_a_follow_up_cancels_the_in_flight_loop_without_an_orphan_turn() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"echo a","risk_level":"medium"}),
        json!({"type":"command","final":false,"content":"sleep 5","risk_level":"low","explanation":"waiting"}),
        json!({"type":"reply","content":"never reached","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty()
        .on(
            confirming("echo a"),
            AppEvent::KeyAction(ActionId::Followup),
        )
        .on(
            is(StateTag::ComposingFollowup),
            AppEvent::SubmitFollowup {
                text: "again".into(),
            },
        )
        // The status line carries the step explanation only once the step
        // is running, so this Esc lands mid-capture.
        .on(
            |s| s.tag() == StateTag::ProcessingFollowup && s.status() == Some("waiting"),
            AppEvent::KeyEsc,
        )
        .on(
            |s| s.tag() == StateTag::ComposingFollowup && s.draft() == Some("again"),
            AppEvent::KeyEsc,
        )
        .on(confirming("echo a"), AppEvent::KeyEsc);
    let started = std::time::Instant::now();
    let code = run("start", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(0));
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the step was killed"
    );
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "cancelled");
    assert_eq!(
        turn_kinds(&entry),
        ["user", "assistant", "user", "assistant", "final"]
    );
    assert_eq!(final_turn(&entry), Some(("echo a", None, "cancelled")));
}

#[tokio::test]
async fn a_confirmed_non_final_step_is_captured_into_the_dialog_and_the_loop_continues() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"echo probed-value","risk_level":"medium"}),
        json!({"type":"reply","content":"it is probed-value","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty().on(is(StateTag::Confirming), AppEvent::KeyAction(ActionId::Run));
    let code = run("probe", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(0));
    let entry = rig.last_entry();
    assert_eq!(
        turn_kinds(&entry),
        ["user", "assistant", "step", "assistant"]
    );
    match &entry.turns[2] {
        Turn::Step {
            command,
            output,
            source,
            ..
        } => {
            assert_eq!(command, "echo probed-value");
            assert!(output.contains("probed-value"));
            assert_eq!(source, "model");
        }
        other => panic!("{other:?}"),
    }
    assert!(
        host.shown.iter().any(|s| matches!(
            s,
            AppState::ExecutingStep { output_slot: Some(slot), .. } if slot.contains("probed-value")
        )),
        "the step output reached the dialog's output slot"
    );
}

#[tokio::test]
async fn an_edited_non_final_step_records_the_override_source() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"echo model","risk_level":"medium"}),
        json!({"type":"reply","content":"ok","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty()
        .on(
            is(StateTag::Confirming),
            AppEvent::KeyAction(ActionId::Edit),
        )
        .on(
            is(StateTag::Editing),
            AppEvent::SubmitEdit {
                text: "echo edited".into(),
            },
        );
    assert_eq!(
        run("probe", &llm, rig.options(|_| {}), &mut host).await,
        Ok(0)
    );
    let entry = rig.last_entry();
    match &entry.turns[2] {
        Turn::Step {
            command, source, ..
        } => {
            assert_eq!(command, "echo edited");
            assert_eq!(source, StepSource::UserOverride.as_str());
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(assistant_contents(&entry), ["echo model", "ok"]);
}

#[tokio::test]
async fn an_external_editor_round_trip_unmounts_and_restores_the_dialog() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"exit 1","risk_level":"medium"}),
    ]);
    let mut host = FakeHost::tty()
        .on(
            is(StateTag::Confirming),
            AppEvent::KeyAction(ActionId::Edit),
        )
        .on(
            |s| s.tag() == StateTag::Editing && s.draft() == Some("exit 1"),
            AppEvent::EnterEditor {
                draft: "exit 1".into(),
            },
        )
        .on(
            |s| s.tag() == StateTag::Editing && s.draft() == Some("exit 5"),
            AppEvent::SubmitEdit {
                text: "exit 5".into(),
            },
        );
    host.editor_result = Some("exit 5".into());
    let code = run("edit", &llm, rig.options(|_| {}), &mut host).await;
    assert_eq!(code, Ok(5));
    assert_eq!(
        host.log,
        [
            "mount:Confirming",
            "unmount",
            "editor",
            "mount:Editing",
            "unmount"
        ]
    );
    assert_eq!(host.editor_drafts, ["exit 1"]);
}

#[tokio::test]
async fn chrome_emitted_while_the_dialog_is_up_is_flushed_after_unmount() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"echo a","risk_level":"medium"}),
        json!({"type":"command","final":false,"content":"true","risk_level":"low","explanation":"Checking tools"}),
        json!({"type":"command","content":"true","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty()
        .on(
            confirming("echo a"),
            AppEvent::KeyAction(ActionId::Followup),
        )
        .on(
            is(StateTag::ComposingFollowup),
            AppEvent::SubmitFollowup { text: "go".into() },
        )
        .on(confirming("true"), AppEvent::KeyAction(ActionId::Run));
    assert_eq!(
        run("start", &llm, rig.options(|_| {}), &mut host).await,
        Ok(0)
    );
    let unmount = host.log.iter().position(|l| l == "unmount").unwrap();
    let flushed = host
        .log
        .iter()
        .position(|l| l == "stderr:Checking tools")
        .expect("the buffered chrome line was flushed");
    assert!(flushed > unmount, "{:?}", host.log);
    assert!(
        host.shown
            .iter()
            .any(|s| s.status() == Some("Checking tools")),
        "the live dialog showed the step explanation as status"
    );
}

// ── interactive bootstrap ────────────────────────────────────────

#[tokio::test]
async fn an_empty_prompt_on_a_tty_opens_the_composer_and_submits_as_tui_input() {
    let rig = SessionRig::new();
    let sentinel = Skill::new("sentinel", Trigger::Always, |_| {
        vec![SkillTask::computed("echo sentinel", || async {
            Some(TaskResult {
                output: "S".into(),
                exit_code: 0,
            })
        })]
    });
    let llm = llm_list(vec![
        json!({"type":"reply","content":"hello","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty().on(
        is(StateTag::ComposingInteractive),
        AppEvent::SubmitInteractive {
            text: "find ts files".into(),
        },
    );
    let code = run(
        "",
        &llm,
        rig.options(|o| {
            o.skills = Some(vec![sentinel]);
            o.config = config(|c| c.verbose = Some(true));
        }),
        &mut host,
    )
    .await;
    assert_eq!(code, Ok(0));
    assert_eq!(host.log[0], "mount:ComposingInteractive");
    let entry = rig.last_entry();
    assert_eq!(entry.input_source.as_deref(), Some("tui"));
    assert_eq!(turn_kinds(&entry), ["probe", "user", "assistant"]);
    assert_eq!(
        entry.turns[1],
        Turn::User {
            text: "find ts files".into()
        }
    );
    assert!(
        host.stderr_text().contains("prompt: find ts files"),
        "{}",
        host.stderr_text()
    );
    assert!(
        host.shown
            .iter()
            .any(|s| s.tag() == StateTag::ProcessingInteractive)
    );
}

#[tokio::test]
async fn esc_in_the_composer_cancels_with_exit_zero() {
    let rig = SessionRig::new();
    let llm = llm_single("ERROR:never called");
    let mut host = FakeHost::tty().on(is(StateTag::ComposingInteractive), AppEvent::KeyEsc);
    assert_eq!(run("", &llm, rig.options(|_| {}), &mut host).await, Ok(0));
    let entry = rig.last_entry();
    assert_eq!(entry.outcome, "cancelled");
    assert_eq!(turn_kinds(&entry), ["final"]);
}

#[tokio::test]
async fn an_empty_prompt_without_a_tty_is_sent_as_is() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"reply","content":"?","risk_level":"low"}),
    ]);
    let mut host = FakeHost::no_tty();
    assert_eq!(run("", &llm, rig.options(|_| {}), &mut host).await, Ok(0));
    assert_eq!(turn_kinds(&rig.last_entry()), ["user", "assistant"]);
}

// ── continuation ─────────────────────────────────────────────────

#[tokio::test]
async fn a_continuation_replays_the_chain_but_persists_only_its_own_turns() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"true","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    let code = run(
        "ok do it",
        &llm,
        rig.options(|o| {
            o.config = config(|c| c.log_traces = Some(true));
            o.continuation_parent = Some(ContinuationParent {
                parent_id: "parent-1".into(),
                assembled_turns: vec![
                    Turn::User {
                        text: "how do I deploy".into(),
                    },
                    Turn::Assistant {
                        response: Some(session_common::reply("you run deploy.sh")),
                        attempts: Vec::new(),
                        llm_ms: None,
                        source: "model".into(),
                    },
                ],
                parent_prompt: "how do I deploy".into(),
            });
        }),
        &mut host,
    )
    .await;
    assert_eq!(code, Ok(0));
    let entry = rig.last_entry();
    assert_eq!(entry.parent_id.as_deref(), Some("parent-1"));
    assert_eq!(turn_kinds(&entry), ["user", "assistant", "final"]);
    assert_eq!(
        entry.turns[0],
        Turn::User {
            text: "ok do it".into()
        }
    );

    let trace: serde_json::Value = serde_json::from_str(
        &rig.home
            .read(&format!("logs/traces/{}.json", entry.id))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let messages = trace["turn_attempts"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()[0]["request"]["messages"]
        .as_array()
        .unwrap()
        .clone();
    let users: Vec<&str> = messages
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["content"].as_str().unwrap())
        .collect();
    let framed: Vec<_> = users
        .iter()
        .filter(|c| c.contains("## User's request"))
        .collect();
    assert_eq!(framed.len(), 1);
    assert!(framed[0].contains("## User's request\nhow do I deploy"));
    assert!(users.contains(&"ok do it"));
    assert!(messages.iter().any(|m| m["role"] == "assistant"
        && m["content"].as_str().unwrap().contains("you run deploy.sh")));
}

#[tokio::test]
async fn the_continuation_badge_reaches_the_dialog() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"command","content":"true","risk_level":"medium"}),
    ]);
    let mut host = FakeHost::tty().on(is(StateTag::Confirming), AppEvent::KeyEsc);
    run(
        "again",
        &llm,
        rig.options(|o| {
            o.continuation_parent = Some(ContinuationParent {
                parent_id: "p".into(),
                assembled_turns: vec![Turn::User {
                    text: "first".into(),
                }],
                parent_prompt: "first".into(),
            })
        }),
        &mut host,
    )
    .await
    .unwrap();
    assert_eq!(host.continuation_prompt.as_deref(), Some("first"));
}

#[tokio::test]
async fn verbose_lines_from_the_initial_loop_reach_stderr_as_they_happen() {
    let rig = SessionRig::new();
    let llm = llm_list(vec![
        json!({"type":"reply","content":"world","risk_level":"low"}),
    ]);
    let mut host = FakeHost::tty();
    run(
        "hello",
        &llm,
        rig.options(|o| o.config = config(|c| c.verbose = Some(true))),
        &mut host,
    )
    .await
    .unwrap();
    let text = host.stderr_text();
    assert!(text.contains("Calling test / (default)..."), "{text}");
    assert!(text.contains("LLM responded (reply, 5 chars)"), "{text}");
}
