// The bus lock serializes tests that observe the process-global chrome bus;
// each test runs on a single thread, so holding it across awaits is safe.
#![allow(clippy::await_holding_lock)]
mod session_common;

use std::path::PathBuf;

use serde_json::{Value, json};
use session_common::{BusCapture, bus_lock, config, default_config, llm_list, llm_single};
use tempfile::TempDir;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use tokio_util::sync::CancellationToken;
use wrap::chrome::Notification;
use wrap::home::WrapHome;
use wrap::llm::{ConversationOptions, Llm, replayable};
use wrap::logging::Turn;
use wrap::memory::load_memory;
use wrap::prompt::{TurnFramer, format_command_echo};
use wrap::session::runner::{LoopEvent, LoopOptions, LoopState, Transcript, fetches_url, run_loop};
use wrap::session::state::LoopReturn;
use wrap::watchlist::load_watchlist;

struct Rig {
    transcript: Transcript,
    state: LoopState,
    options: LoopOptions,
    events: UnboundedReceiver<LoopEvent>,
    _home: TempDir,
}

fn rig_with(llm: &Llm, budget: u32, patch: impl FnOnce(&mut LoopOptions)) -> Rig {
    let chat = llm.start_conversation(ConversationOptions {
        system: "system".into(),
        format_echo: Some(format_command_echo()),
    });
    let mut transcript = Transcript::new(chat, TurnFramer::new(None));
    transcript.append_turn(Turn::User { text: "hi".into() });
    let home = tempfile::tempdir().unwrap();
    let (tx, events) = unbounded_channel();
    let mut options = LoopOptions {
        cwd: PathBuf::from("/tmp"),
        label: "test / model".into(),
        home: WrapHome::new(home.path()),
        config: default_config(),
        show_spinner: false,
        cancel: CancellationToken::new(),
        events: tx,
    };
    patch(&mut options);
    Rig {
        transcript,
        state: LoopState {
            budget_remaining: budget,
            round_num: 0,
        },
        options,
        events,
        _home: home,
    }
}

fn rig(items: Vec<Value>) -> Rig {
    rig_with(&llm_list(items), 5, |_| {})
}

impl Rig {
    async fn run(&mut self) -> Result<LoopReturn, String> {
        run_loop(&mut self.transcript, &mut self.state, &self.options).await
    }

    fn drain(&mut self) -> Vec<LoopEvent> {
        let mut out = Vec::new();
        while let Ok(e) = self.events.try_recv() {
            out.push(e);
        }
        out
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.transcript
            .turns
            .iter()
            .map(|t| match t {
                Turn::User { .. } => "user",
                Turn::Assistant { .. } => "assistant",
                Turn::Step { .. } => "step",
                Turn::Probe { .. } => "probe",
                Turn::Final { .. } => "final",
            })
            .collect()
    }

    fn physical_calls(&self) -> usize {
        self.transcript
            .chat
            .entries()
            .iter()
            .map(|e| e.attempts.len())
            .sum()
    }
}

fn step_event_count(events: &[LoopEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, LoopEvent::StepOutput { .. }))
        .count()
}

/// The `🔍`/`🌐` chrome lines captured from the bus, as (icon, text).
fn step_chrome(notifications: &[Notification]) -> Vec<(String, String)> {
    notifications
        .iter()
        .filter_map(|n| match n {
            Notification::Chrome {
                text,
                icon: Some(icon),
            } if icon == "🔍" || icon == "🌐" => Some((icon.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_final_command_pushes_one_assistant_turn_and_returns_it() {
    let mut rig = rig(vec![
        json!({"type":"command","content":"ls","risk_level":"medium"}),
    ]);
    let result = rig.run().await.unwrap();
    assert!(matches!(result, LoopReturn::Command(r) if r.content == "ls"));
    let events = rig.drain();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], LoopEvent::AssistantTurn { .. }));
    assert_eq!(rig.kinds(), ["user", "assistant"]);
    assert_eq!(rig.state.round_num, 1);
}

#[tokio::test]
async fn a_reply_returns_the_answer() {
    let mut rig = rig(vec![
        json!({"type":"reply","content":"hi back","risk_level":"low"}),
    ]);
    let result = rig.run().await.unwrap();
    assert_eq!(result, LoopReturn::Answer("hi back".into()));
    assert_eq!(rig.kinds(), ["user", "assistant"]);
}

#[tokio::test]
async fn a_non_final_low_step_runs_inline_and_is_framed_into_the_conversation() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let mut rig = rig(vec![
        json!({"type":"command","final":false,"content":"echo discovered","risk_level":"low","explanation":"check"}),
        json!({"type":"command","final":true,"content":"echo done","risk_level":"low"}),
    ]);
    let result = rig.run().await.unwrap();
    assert!(matches!(result, LoopReturn::Command(r) if r.content == "echo done"));
    let events = rig.drain();
    assert_eq!(step_event_count(&events), 1);
    // Other tests' steps share the bus, so look for this one rather than
    // for an exact list.
    assert!(step_chrome(&capture.drain()).contains(&("🔍".to_string(), "check".to_string())));
    assert!(events.iter().any(|e| matches!(
        e,
        LoopEvent::StepOutput { text } if text.contains("discovered")
    )));
    assert_eq!(rig.kinds(), ["user", "assistant", "step", "assistant"]);
    match &rig.transcript.turns[2] {
        Turn::Step {
            command,
            exit_code,
            output,
            source,
            ..
        } => {
            assert_eq!(command, "echo discovered");
            assert_eq!(*exit_code, 0);
            assert!(output.contains("discovered"));
            assert_eq!(source, "model");
        }
        other => panic!("{other:?}"),
    }
    let replayed: Vec<_> = rig
        .transcript
        .chat
        .entries()
        .iter()
        .filter(|e| replayable(e))
        .filter_map(|e| e.message.clone())
        .collect();
    assert_eq!(replayed.len(), 4);
    assert!(replayed[2].content.contains("## Captured output"));
    assert!(replayed[2].content.contains("discovered"));
}

#[tokio::test]
async fn the_step_explanation_falls_back_to_the_command_and_url_fetches_get_the_globe() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let mut rig = rig(vec![
        json!({"type":"command","final":false,"content":"echo curl https://example.com","risk_level":"low"}),
        json!({"type":"reply","content":"done","risk_level":"low"}),
    ]);
    rig.run().await.unwrap();
    assert!(step_chrome(&capture.drain()).contains(&(
        "🔍".to_string(),
        "echo curl https://example.com".to_string()
    )));
    assert!(fetches_url("curl -sL https://example.com"));
    assert!(fetches_url("  wget -qO- http://example.com | head"));
    assert!(!fetches_url("curl --version"));
    assert!(!fetches_url("echo https://example.com"));
    assert!(!fetches_url("ls && curl https://example.com"));
}

#[tokio::test]
async fn yolo_runs_non_final_medium_and_high_steps_inline() {
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"echo m","risk_level":"medium"}),
        json!({"_scratchpad":"noop","type":"command","final":false,"content":"echo h","risk_level":"high"}),
        json!({"type":"command","final":true,"content":"echo done","risk_level":"low"}),
    ]);
    let mut rig = rig_with(&llm, 5, |o| o.config = config(|c| c.yolo = Some(true)));
    let result = rig.run().await.unwrap();
    assert!(matches!(result, LoopReturn::Command(_)));
    assert_eq!(step_event_count(&rig.drain()), 2);
    assert_eq!(
        rig.kinds(),
        [
            "user",
            "assistant",
            "step",
            "assistant",
            "step",
            "assistant"
        ]
    );
}

#[tokio::test]
async fn a_non_final_medium_step_returns_to_the_coordinator_without_running() {
    let mut rig = rig(vec![
        json!({"type":"command","final":false,"content":"echo git-stash-fake","risk_level":"medium","plan":"stash, test, pop"}),
    ]);
    let result = rig.run().await.unwrap();
    assert!(matches!(result, LoopReturn::Command(r) if !r.is_final));
    assert_eq!(step_event_count(&rig.drain()), 0);
    assert_eq!(rig.kinds(), ["user", "assistant"]);
}

#[tokio::test]
async fn the_loop_is_exhausted_when_the_budget_runs_out() {
    let step = json!({"type":"command","final":false,"content":"true","risk_level":"low"});
    let llm = llm_list(vec![step.clone(), step.clone(), step]);
    let mut rig = rig_with(&llm, 2, |o| o.config = config(|c| c.max_rounds = Some(2)));
    let result = rig.run().await.unwrap();
    assert_eq!(result, LoopReturn::Exhausted);
    assert_eq!(rig.state.round_num, 2);
    assert_eq!(rig.state.budget_remaining, 0);
}

#[tokio::test]
async fn a_non_final_step_on_the_last_round_is_exhausted_without_running() {
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"echo should-not-run","risk_level":"low"}),
    ]);
    let mut rig = rig_with(&llm, 1, |_| {});
    let result = rig.run().await.unwrap();
    assert_eq!(result, LoopReturn::Exhausted);
    assert_eq!(step_event_count(&rig.drain()), 0);
    assert_eq!(rig.kinds(), ["user", "assistant"]);
}

#[tokio::test]
async fn step_output_separates_stdout_from_stderr_with_a_newline() {
    let mut rig = rig(vec![
        json!({"type":"command","final":false,"content":"printf OUT; printf ERR >&2","risk_level":"low"}),
        json!({"type":"command","final":true,"content":"true","risk_level":"low"}),
    ]);
    rig.run().await.unwrap();
    let outputs: Vec<String> = rig
        .drain()
        .into_iter()
        .filter_map(|e| match e {
            LoopEvent::StepOutput { text } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(outputs.len(), 1);
    assert!(outputs[0].starts_with("OUT\n"), "{:?}", outputs[0]);
    assert!(outputs[0].contains("ERR"));
}

#[tokio::test]
async fn step_output_is_truncated_to_the_configured_budget() {
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"seq 1 2000","risk_level":"low"}),
        json!({"type":"reply","content":"done","risk_level":"low"}),
    ]);
    let mut rig = rig_with(&llm, 5, |o| {
        o.config = config(|c| c.max_captured_output_chars = Some(300))
    });
    rig.run().await.unwrap();
    let text = rig
        .drain()
        .into_iter()
        .find_map(|e| match e {
            LoopEvent::StepOutput { text } => Some(text),
            _ => None,
        })
        .unwrap();
    assert!(text.chars().count() < 500, "{}", text.chars().count());
    assert!(text.starts_with("1\n"));
    assert!(text.contains("[…truncated, showing first"), "{text}");
    assert!(!text.contains("\n1000\n"), "the middle is cut: {text}");
    match &rig.transcript.turns[2] {
        Turn::Step { output, .. } => assert_eq!(output, &text),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_pre_cancelled_token_aborts_before_any_call() {
    let llm = llm_single("ERROR:should never be called");
    let mut rig = rig_with(&llm, 5, |o| {
        let token = CancellationToken::new();
        token.cancel();
        o.cancel = token;
    });
    let result = rig.run().await.unwrap();
    assert_eq!(result, LoopReturn::Aborted);
    assert!(rig.drain().is_empty());
    assert_eq!(rig.physical_calls(), 0);
}

#[tokio::test]
async fn cancelling_during_the_step_aborts_without_pushing_a_step_turn() {
    let mut rig = rig(vec![
        json!({"type":"command","final":false,"content":"sleep 5","risk_level":"low","explanation":"wait"}),
    ]);
    let token = rig.options.cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        token.cancel();
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(4), rig.run())
        .await
        .expect("the cancel must end the loop promptly")
        .unwrap();
    assert_eq!(result, LoopReturn::Aborted);
    assert_eq!(rig.kinds(), ["user", "assistant"]);
    assert!(
        !rig.drain()
            .iter()
            .any(|e| matches!(e, LoopEvent::StepOutput { .. }))
    );
}

/// A chat-completions endpoint that answers `replies` in order and then
/// holds the next request open after firing `cancel`: the one way to land
/// an abort inside a send rather than between rounds.
async fn hold_after(replies: Vec<String>, cancel: CancellationToken) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let mut replies = replies.into_iter();
        let mut held = Vec::new();
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read the whole request so the client never sees a reset.
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let head = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = head.find("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            match replies.next() {
                Some(body) => {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                    socket.shutdown().await.ok();
                }
                None => {
                    cancel.cancel();
                    held.push(socket);
                }
            }
        }
    });
    base_url
}

fn completion(content: Value) -> String {
    json!({"choices": [{"message": {"role": "assistant", "content": content.to_string()}, "finish_reason": "stop"}]})
        .to_string()
}

fn http_llm(base_url: &str) -> Llm {
    Llm::new(
        wrap::llm::LlmConfig::Provider(wrap::llm::ResolvedProvider {
            name: "local-fake".into(),
            model: Some("fake-model".into()),
            api_key: Some("sk-local-fake-key-7890".into()),
            base_url: Some(base_url.into()),
        }),
        &std::collections::HashMap::new(),
    )
    .unwrap()
}

#[tokio::test]
async fn an_aborted_send_returns_aborted_with_no_assistant_turn() {
    let token = CancellationToken::new();
    let base_url = hold_after(vec![], token.clone()).await;
    let llm = http_llm(&base_url);
    let mut rig = rig_with(&llm, 5, |o| o.cancel = token);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), rig.run())
        .await
        .expect("the cancel must end the loop promptly")
        .unwrap();
    assert_eq!(result, LoopReturn::Aborted);
    assert!(rig.drain().is_empty());
    assert_eq!(rig.kinds(), ["user"]);
    assert_eq!(rig.physical_calls(), 0);
}

#[tokio::test]
async fn an_abort_after_a_completed_step_keeps_the_step_turn_and_settles_no_more_calls() {
    let token = CancellationToken::new();
    let step = json!({"type":"command","final":false,"content":"true","risk_level":"low","explanation":"ok"});
    let base_url = hold_after(vec![completion(step)], token.clone()).await;
    let llm = http_llm(&base_url);
    let mut rig = rig_with(&llm, 5, |o| o.cancel = token);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), rig.run())
        .await
        .expect("the cancel must end the loop promptly")
        .unwrap();
    assert_eq!(result, LoopReturn::Aborted);
    assert_eq!(rig.kinds(), ["user", "assistant", "step"]);
    assert_eq!(rig.physical_calls(), 1);
    let events = rig.drain();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, LoopEvent::AssistantTurn { .. }))
            .count(),
        1
    );
    assert_eq!(step_event_count(&events), 1);
}

#[tokio::test]
async fn a_failed_round_is_recorded_before_the_error_surfaces() {
    let llm = llm_single("ERROR:network down");
    let mut rig = rig_with(&llm, 5, |_| {});
    let error = rig.run().await.unwrap_err();
    assert_eq!(error, "LLM error (test / model): network down");
    let events = rig.drain();
    assert_eq!(events.len(), 1);
    assert!(
        matches!(&events[0], LoopEvent::AssistantTurn { turn } if matches!(&**turn, Turn::Assistant { response: None, attempts, .. } if attempts.len() == 1))
    );
    assert_eq!(rig.kinds(), ["user", "assistant"]);
    assert_eq!(rig.physical_calls(), 1);
}

#[tokio::test]
async fn memory_updates_are_persisted_and_announced_with_the_deepest_scope() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let cwd = tempfile::tempdir().unwrap();
    let scope = cwd.path().canonicalize().unwrap();
    let llm = llm_list(vec![json!({
        "type":"reply","content":"ok","risk_level":"low",
        "memory_updates":[{"fact":"Uses zsh","scope":"/"},{"fact":"Uses bun","scope":scope.to_str().unwrap()}],
        "memory_updates_message":"Noted: zsh and bun"
    })]);
    let mut rig = rig_with(&llm, 5, |o| {
        o.cwd = scope.clone();
        o.config = config(|c| c.verbose = Some(true));
    });
    rig.run().await.unwrap();
    let memory = load_memory(&rig.options.home).unwrap();
    assert_eq!(memory["/"][0].fact, "Uses zsh");
    assert_eq!(memory[scope.to_str().unwrap()][0].fact, "Uses bun");
    let notifications = capture.drain();
    let expected_prefix = format!("({}) Noted: zsh and bun", wrap::paths::pretty_path(&scope));
    assert!(
        notifications.iter().any(|n| matches!(
            n,
            Notification::Chrome { text, icon: Some(icon) } if icon == "🧠" && *text == expected_prefix
        )),
        "{notifications:?}"
    );
    assert!(notifications.iter().any(|n| matches!(
        n,
        Notification::Verbose { line } if line.contains("Memory updated: 2 facts")
    )));
}

#[tokio::test]
async fn equally_deep_scopes_announce_the_first_one_declared() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let first = root.join("aa");
    let second = root.join("bb");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let llm = llm_list(vec![json!({
        "type":"reply","content":"ok","risk_level":"low",
        "memory_updates":[
            {"fact":"one","scope":first.to_str().unwrap()},
            {"fact":"two","scope":second.to_str().unwrap()}
        ],
        "memory_updates_message":"Noted"
    })]);
    let mut rig = rig_with(&llm, 5, |o| o.cwd = root.clone());
    rig.run().await.unwrap();
    let expected = format!("({}) Noted", wrap::paths::pretty_path(&first));
    let notifications = capture.drain();
    assert!(
        notifications.iter().any(|n| matches!(
            n,
            Notification::Chrome { text, icon: Some(icon) } if icon == "🧠" && *text == expected
        )),
        "{notifications:?}"
    );
}

#[tokio::test]
async fn global_only_memory_updates_announce_without_a_scope_prefix() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let llm = llm_list(vec![json!({
        "type":"reply","content":"ok","risk_level":"low",
        "memory_updates":[{"fact":"Uses zsh","scope":"/"}],
        "memory_updates_message":"Noted: you use zsh"
    })]);
    let mut rig = rig_with(&llm, 5, |_| {});
    rig.run().await.unwrap();
    let notifications = capture.drain();
    assert!(
        notifications.iter().any(|n| matches!(
            n,
            Notification::Chrome { text, icon: Some(icon) } if icon == "🧠" && text == "Noted: you use zsh"
        )),
        "{notifications:?}"
    );
}

#[tokio::test]
async fn watchlist_additions_are_persisted_and_logged_verbosely() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let llm = llm_list(vec![json!({
        "type":"reply","content":"ok","risk_level":"low",
        "watchlist_additions":["sips","magick"]
    })]);
    let mut rig = rig_with(&llm, 5, |o| o.config = config(|c| c.verbose = Some(true)));
    rig.run().await.unwrap();
    let tools: Vec<String> = load_watchlist(&rig.options.home)
        .into_iter()
        .map(|e| e.tool)
        .collect();
    assert_eq!(tools, ["sips", "magick"]);
    assert!(capture.text().contains("Watchlist: added sips, magick"));
}

#[tokio::test]
async fn verbose_narrates_rounds_calls_and_steps() {
    let _lock = bus_lock();
    let mut capture = BusCapture::start();
    let llm = llm_list(vec![
        json!({"type":"command","final":false,"content":"echo step1","risk_level":"low","explanation":"Looking around"}),
        json!({"type":"command","content":"echo done","risk_level":"low"}),
    ]);
    let mut rig = rig_with(&llm, 2, |o| {
        o.config = config(|c| {
            c.verbose = Some(true);
            c.max_rounds = Some(2);
        })
    });
    rig.run().await.unwrap();
    let text = capture.text();
    assert!(text.contains("Calling test / model..."), "{text}");
    assert!(text.contains("Step: echo step1"), "{text}");
    assert!(
        text.find("🔍 Looking around").unwrap() < text.find("Step: echo step1").unwrap(),
        "{text}"
    );
    assert!(text.contains("Step exited (0)"), "{text}");
    assert!(text.contains("Round 2/2"), "{text}");
    assert!(!text.contains("Round 1/2"), "{text}");
    assert!(
        text.contains("Final round: must return command or answer"),
        "{text}"
    );
}
