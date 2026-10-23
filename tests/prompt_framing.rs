use serde_json::json;
use wrap::llm::{LlmMessage, Role};
use wrap::prompt::{
    RequestFraming, Turn, TurnFramer, echo_text, format_command_echo, is_scratchpad_rejected,
    project_response_for_echo,
};
use wrap::response::CommandResponse;

fn response(v: serde_json::Value) -> CommandResponse {
    serde_json::from_value(v).unwrap()
}
fn cmd() -> CommandResponse {
    response(json!({"type":"command","final":true,"content":"ls -la","risk_level":"medium"}))
}
fn step() -> CommandResponse {
    response(json!({"type":"command","final":false,"content":"uname","risk_level":"low"}))
}
fn reply() -> CommandResponse {
    response(json!({"type":"reply","final":true,"content":"the answer","risk_level":"low"}))
}
fn user(s: &str) -> LlmMessage {
    LlmMessage {
        role: Role::User,
        content: s.into(),
    }
}
fn assistant(s: &str) -> LlmMessage {
    LlmMessage {
        role: Role::Assistant,
        content: s.into(),
    }
}
fn step_turn(command: &str, exit_code: i32, output: &str, source: &str) -> Turn {
    Turn::Step {
        command: command.into(),
        exit_code,
        output: output.into(),
        shell: "/bin/sh".into(),
        source: source.into(),
        exec_ms: None,
    }
}
fn assistant_turn(response: Option<CommandResponse>) -> Turn {
    Turn::Assistant {
        response,
        attempts: vec![],
        llm_ms: None,
        source: "model".into(),
    }
}
fn final_turn(command: &str, exit_code: Option<i32>, source: &str) -> Turn {
    Turn::Final {
        command: command.into(),
        exit_code,
        shell: None,
        source: source.into(),
        exec_ms: None,
    }
}
fn frame_all(turns: &[Turn], framing: Option<RequestFraming>) -> Vec<LlmMessage> {
    let mut framer = TurnFramer::new(framing);
    turns.iter().flat_map(|t| framer.frame(t)).collect()
}
fn framing() -> RequestFraming {
    RequestFraming {
        context_string: "ctx-here".into(),
        section_user_request: "## User's request".into(),
    }
}

#[test]
fn user_turns_render_bare_without_framing() {
    let out = frame_all(&[Turn::User { text: "hi".into() }], None);
    assert_eq!(out, vec![user("hi")]);
}

#[test]
fn assistant_turns_echo_the_projected_response_and_failed_rounds_vanish() {
    let out = frame_all(
        &[
            Turn::User { text: "hi".into() },
            assistant_turn(Some(step())),
            step_turn("uname", 0, "out1", "model"),
            assistant_turn(None),
            Turn::User {
                text: "retry".into(),
            },
            assistant_turn(Some(reply())),
        ],
        None,
    );
    assert_eq!(
        out,
        vec![
            user("hi"),
            assistant(r#"{"type":"command","final":false,"content":"uname","risk_level":"low"}"#),
            user("## Captured output\nout1"),
            user("retry"),
            assistant(r#"{"type":"reply","final":true,"content":"the answer","risk_level":"low"}"#),
        ]
    );
}

#[test]
fn step_bodies_trim_fall_back_to_the_no_output_sentinel_and_append_exit_codes() {
    let render = |exit: i32, output: &str| {
        frame_all(&[step_turn("uname", exit, output, "model")], None)[0]
            .content
            .clone()
    };
    assert_eq!(render(0, ""), "## Captured output\n(no output)");
    assert_eq!(render(0, "  \n  "), "## Captured output\n(no output)");
    assert_eq!(render(0, "hi\n"), "## Captured output\nhi");
    assert_eq!(render(2, "boom"), "## Captured output\nboom\nExit code: 2");
    assert_eq!(render(3, ""), "## Captured output\nExit code: 3");
}

#[test]
fn user_override_steps_render_like_model_steps() {
    let a = frame_all(
        &[step_turn(
            "echo git-stash-fake",
            0,
            "Saved.",
            "user_override",
        )],
        None,
    );
    let b = frame_all(
        &[step_turn("echo git-stash-fake", 0, "Saved.", "model")],
        None,
    );
    assert_eq!(a, b);
}

#[test]
fn probe_turns_expand_to_the_same_pair_as_a_low_risk_non_final_step() {
    let from_pair = frame_all(
        &[
            Turn::User { text: "hi".into() },
            assistant_turn(Some(step())),
            step_turn("uname", 0, "Linux", "model"),
        ],
        None,
    );
    let from_probe = frame_all(
        &[
            Turn::User { text: "hi".into() },
            Turn::Probe {
                skill: "discovery".into(),
                command: "uname".into(),
                output: "Linux".into(),
            },
        ],
        None,
    );
    assert_eq!(from_probe, from_pair);

    let empty = frame_all(
        &[Turn::Probe {
            skill: "discovery".into(),
            command: "pwd".into(),
            output: String::new(),
        }],
        None,
    );
    assert_eq!(empty[1].content, "## Captured output\n(no output)");
}

#[test]
fn request_framing_wraps_only_the_first_user_turn_even_across_calls() {
    let out = frame_all(
        &[
            Turn::User {
                text: "first".into(),
            },
            assistant_turn(Some(cmd())),
            Turn::User {
                text: "second".into(),
            },
            Turn::User {
                text: "third".into(),
            },
        ],
        Some(framing()),
    );
    assert_eq!(out[0].content, "ctx-here\n\n## User's request\nfirst");
    assert_eq!(out[2].content, "second");
    assert_eq!(out[3].content, "third");

    let mut framer = TurnFramer::new(Some(framing()));
    let first = framer.frame(&Turn::User {
        text: "first".into(),
    });
    let later = framer.frame(&Turn::User {
        text: "later follow-up".into(),
    });
    assert!(first[0].content.contains("## User's request\nfirst"));
    assert_eq!(later[0].content, "later follow-up");
}

#[test]
fn empty_context_omits_the_leading_separator() {
    let out = frame_all(
        &[Turn::User { text: "go".into() }],
        Some(RequestFraming {
            context_string: String::new(),
            section_user_request: "## User's request".into(),
        }),
    );
    assert_eq!(out[0].content, "## User's request\ngo");
}

#[test]
fn probe_and_step_user_messages_do_not_consume_the_framing() {
    let out = frame_all(
        &[
            Turn::Probe {
                skill: "discovery".into(),
                command: "pwd".into(),
                output: "/home".into(),
            },
            step_turn("which ffmpeg", 0, "/opt/homebrew/bin/ffmpeg", "model"),
            Turn::User {
                text: "list files".into(),
            },
        ],
        Some(framing()),
    );
    assert_eq!(out[3].content, "ctx-here\n\n## User's request\nlist files");
}

#[test]
fn final_turns_render_as_wrap_notes_per_source() {
    let note = |turn: Turn| frame_all(&[turn], None)[0].clone();
    assert_eq!(
        note(final_turn("git push heroku main", Some(0), "model")),
        user("<wrap-note>\nprevious command exited 0\n</wrap-note>")
    );
    assert_eq!(
        note(final_turn(
            "cat <<EOF > foo.txt\nhello\nEOF",
            Some(0),
            "user_override"
        ))
        .content,
        "<wrap-note>\nuser ran the following instead of the proposal; exited 0:\ncat <<EOF > foo.txt\nhello\nEOF\n</wrap-note>"
    );
    assert_eq!(
        note(final_turn("git push heroku main", None, "cancelled")).content,
        "<wrap-note>\nuser cancelled the previous command: git push heroku main\n</wrap-note>"
    );
    assert_eq!(
        note(final_turn("echo rm-rf-fake", None, "blocked")).content,
        "<wrap-note>\nprevious command was blocked\n</wrap-note>"
    );
    assert_eq!(
        note(final_turn("git push heroku main", None, "exhausted")).content,
        "<wrap-note>\nprevious run hit the round budget without completing or executing the proposed command; last proposal was: git push heroku main\n</wrap-note>"
    );
    assert_eq!(
        note(final_turn("", None, "exhausted")).content,
        "<wrap-note>\nprevious run hit the round budget without completing\n</wrap-note>"
    );
    assert_eq!(
        note(final_turn("anything", None, "error")).content,
        "<wrap-note>\nprevious run ended in an error before completing\n</wrap-note>"
    );
}

#[test]
fn projection_keeps_only_model_facing_fields_in_order_and_plan_when_set() {
    let rich = response(json!({
        "_scratchpad": "private plan", "type": "command", "final": true, "content": "ls",
        "risk_level": "low", "explanation": "this is user-facing",
        "memory_updates": [{"fact": "uses zsh", "scope": "/"}],
        "memory_updates_message": "Noted: zsh", "watchlist_additions": ["eza"]
    }));
    assert_eq!(
        echo_text(&rich),
        r#"{"type":"command","final":true,"content":"ls","risk_level":"low"}"#
    );
    let mut with_plan = step();
    with_plan.plan = Some("probe, then act".into());
    assert_eq!(
        project_response_for_echo(&with_plan),
        json!({"type":"command","final":false,"content":"uname","risk_level":"low","plan":"probe, then act"})
    );
    assert!(project_response_for_echo(&step()).get("plan").is_none());
}

#[test]
fn echo_predicate_rejects_only_high_risk_commands_without_a_scratchpad() {
    let echo = format_command_echo();
    let raw = serde_json::to_value(cmd()).unwrap();
    assert_eq!(echo(&raw, "raw"), Some(echo_text(&cmd())));

    let rejected = response(
        json!({"_scratchpad": null, "type": "command", "final": true,
        "content": "echo rm-rf-fake", "risk_level": "high"}),
    );
    assert!(is_scratchpad_rejected(&rejected));
    assert_eq!(echo(&serde_json::to_value(&rejected).unwrap(), "raw"), None);
    let omitted = json!({"type": "command", "content": "echo rm-rf-fake", "risk_level": "high"});
    assert_eq!(echo(&omitted, "raw"), None);

    let with_pad = json!({"_scratchpad": "deliberate destruction", "type": "command",
        "content": "echo rm-rf-fake", "risk_level": "high"});
    let echoed = echo(&with_pad, "raw").unwrap();
    assert!(!echoed.contains("deliberate destruction"));

    let medium = json!({"_scratchpad": null, "type": "command", "content": "mkdir build", "risk_level": "medium"});
    assert!(echo(&medium, "raw").is_some());
    let high_reply = json!({"_scratchpad": null, "type": "reply", "content": "the answer", "risk_level": "high"});
    assert!(echo(&high_reply, "raw").is_some());
    assert!(!is_scratchpad_rejected(&reply()));
}

#[test]
fn turns_serialize_with_the_log_shape() {
    let turn = final_turn("ls", None, "cancelled");
    assert_eq!(
        serde_json::to_value(&turn).unwrap(),
        json!({"kind": "final", "command": "ls", "exit_code": null, "source": "cancelled"})
    );
    let probe: Turn = serde_json::from_value(
        json!({"kind": "probe", "skill": "discovery", "command": "pwd", "output": "/x"}),
    )
    .unwrap();
    assert!(matches!(probe, Turn::Probe { ref skill, .. } if skill == "discovery"));
    let assistant: Turn = serde_json::from_value(
        json!({"kind": "assistant", "attempts": [{"error": {"kind": "provider", "message": "x"}}], "source": "model"}),
    )
    .unwrap();
    assert!(matches!(assistant, Turn::Assistant { response: None, .. }));
}
