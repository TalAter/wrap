// The bus lock serializes tests that observe the process-global chrome bus;
// each test runs on a single thread, so holding it across awaits is safe.
#![allow(clippy::await_holding_lock)]
mod session_common;

use serde_json::json;
use session_common::{BusCapture, bus_lock, cmd, final_turn, reply, response, test_provider};
use wrap::logging::{LogEntry, LogEntryParams, Turn, create_log_entry};
use wrap::session::finalise_outcome;
use wrap::session::state::{SessionOutcome, StepSource};

fn fresh_entry() -> LogEntry {
    create_log_entry(LogEntryParams {
        cwd: "/tmp".into(),
        attached_input: None,
        memory: None,
        provider: test_provider(),
        prompt_hash: "h".into(),
        input_source: None,
        ppid: None,
    })
}

fn assistant(response: wrap::response::CommandResponse) -> Turn {
    Turn::Assistant {
        response: Some(response),
        attempts: Vec::new(),
        llm_ms: None,
        source: "model".into(),
    }
}

async fn finalise(outcome: SessionOutcome, entry: &mut LogEntry) -> Result<i32, String> {
    let mut stdout = Vec::new();
    finalise_outcome(outcome, entry, false, &mut stdout).await
}

#[tokio::test]
async fn answer_prints_to_stdout_with_no_final_turn() {
    let mut entry = fresh_entry();
    let mut stdout = Vec::new();
    let code = finalise_outcome(
        SessionOutcome::Answer("the answer".into()),
        &mut entry,
        false,
        &mut stdout,
    )
    .await
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(String::from_utf8(stdout).unwrap(), "the answer\n");
    assert_eq!(entry.outcome, "success");
    assert_eq!(final_turn(&entry), None);
}

#[tokio::test]
async fn cancel_exits_zero_with_the_response_command_or_the_last_proposal() {
    let mut entry = fresh_entry();
    let code = finalise(
        SessionOutcome::Cancel {
            response: Some(cmd("git push", "medium")),
        },
        &mut entry,
    )
    .await
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(entry.outcome, "cancelled");
    assert_eq!(final_turn(&entry), Some(("git push", None, "cancelled")));

    let mut entry = fresh_entry();
    entry.turns.push(Turn::User { text: "x".into() });
    entry.turns.push(assistant(cmd("echo fallback", "low")));
    finalise(SessionOutcome::Cancel { response: None }, &mut entry)
        .await
        .unwrap();
    assert_eq!(
        final_turn(&entry),
        Some(("echo fallback", None, "cancelled"))
    );
}

#[tokio::test]
async fn blocked_exits_one_with_the_blocked_command() {
    let mut entry = fresh_entry();
    let code = finalise(
        SessionOutcome::Blocked {
            command: "echo rm-rf-fake".into(),
            response: None,
        },
        &mut entry,
    )
    .await
    .unwrap();
    assert_eq!(code, 1);
    assert_eq!(entry.outcome, "blocked");
    assert_eq!(
        final_turn(&entry),
        Some(("echo rm-rf-fake", None, "blocked"))
    );
}

#[tokio::test]
async fn exhausted_exits_one_reporting_the_rounds_used_and_the_last_model_proposal() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let mut entry = fresh_entry();
    entry.turns.push(Turn::User { text: "x".into() });
    entry.turns.push(assistant(response(
        json!({"type":"command","final":false,"content":"old proposal","risk_level":"low"}),
    )));
    entry.turns.push(Turn::Step {
        command: "user-edited-bytes".into(),
        exit_code: 0,
        output: String::new(),
        shell: "/bin/sh".into(),
        source: "user_override".into(),
        exec_ms: None,
    });
    entry.turns.push(assistant(cmd("latest proposal", "low")));
    entry.turns.push(assistant(reply("an answer")));
    let code = finalise(SessionOutcome::Exhausted, &mut entry)
        .await
        .unwrap();
    assert_eq!(code, 1);
    assert_eq!(entry.outcome, "max_rounds");
    assert_eq!(
        final_turn(&entry),
        Some(("latest proposal", None, "exhausted"))
    );
    assert!(
        capture
            .text()
            .contains("Could not resolve the request within 3 rounds.")
    );
}

#[tokio::test]
async fn exhausted_without_any_proposal_records_an_empty_command() {
    let _lock = bus_lock();
    let _capture = BusCapture::start();
    let mut entry = fresh_entry();
    entry.turns.push(Turn::User { text: "go".into() });
    finalise(SessionOutcome::Exhausted, &mut entry)
        .await
        .unwrap();
    assert_eq!(final_turn(&entry), Some(("", None, "exhausted")));
}

#[tokio::test]
async fn error_records_a_final_turn_then_returns_the_message() {
    let mut entry = fresh_entry();
    entry.turns.push(assistant(cmd("would-have-run", "low")));
    let result = finalise(SessionOutcome::Error("boom".into()), &mut entry).await;
    assert_eq!(result, Err("boom".into()));
    assert_eq!(entry.outcome, "error");
    assert_eq!(final_turn(&entry), Some(("would-have-run", None, "error")));
}

#[tokio::test]
async fn run_executes_with_inherited_stdio_and_records_the_exit_code() {
    let mut entry = fresh_entry();
    let code = finalise(
        SessionOutcome::Run {
            command: "exit 3".into(),
            response: cmd("exit 3", "low"),
            source: StepSource::UserOverride,
        },
        &mut entry,
    )
    .await
    .unwrap();
    assert_eq!(code, 3);
    assert_eq!(entry.outcome, "error");
    match &entry.turns[0] {
        Turn::Final {
            command,
            exit_code,
            shell,
            source,
            exec_ms,
        } => {
            assert_eq!(command, "exit 3");
            assert_eq!(*exit_code, Some(3));
            assert!(shell.is_some());
            assert_eq!(source, "user_override");
            assert!(exec_ms.is_some());
        }
        other => panic!("{other:?}"),
    }

    let mut entry = fresh_entry();
    let code = finalise(
        SessionOutcome::Run {
            command: "true".into(),
            response: cmd("true", "low"),
            source: StepSource::Model,
        },
        &mut entry,
    )
    .await
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(entry.outcome, "success");
    assert_eq!(final_turn(&entry), Some(("true", Some(0), "model")));
}
