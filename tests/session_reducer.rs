mod session_common;

use session_common::{cmd, reply, step};
use wrap::chrome::Notification;
use wrap::response::CommandResponse;
use wrap::session::reduce;
use wrap::session::state::{
    ActionId, AppEvent, AppState, EditorOrigin, LoopReturn, SessionOutcome, StepSource,
};

fn confirming(response: CommandResponse) -> AppState {
    AppState::Confirming {
        response,
        output_slot: None,
        answer: None,
    }
}

fn confirming_with_slot(response: CommandResponse, slot: &str) -> AppState {
    AppState::Confirming {
        response,
        output_slot: Some(slot.into()),
        answer: None,
    }
}

fn editing(response: CommandResponse) -> AppState {
    let draft = response.content.clone();
    AppState::Editing {
        response,
        draft,
        output_slot: None,
        answer: None,
    }
}

fn composing(response: CommandResponse) -> AppState {
    AppState::ComposingFollowup {
        response,
        draft: String::new(),
        output_slot: None,
        answer: None,
    }
}

fn processing(response: CommandResponse) -> AppState {
    AppState::ProcessingFollowup {
        response,
        draft: "be safer".into(),
        status: None,
        output_slot: None,
        answer: None,
    }
}

fn executing(response: CommandResponse) -> AppState {
    AppState::ExecutingStep {
        response,
        source: StepSource::Model,
        output_slot: None,
        answer: None,
    }
}

fn final_command(response: CommandResponse) -> AppEvent {
    AppEvent::LoopFinal {
        result: LoopReturn::Command(response),
    }
}

fn chrome(text: &str) -> AppEvent {
    AppEvent::Notification(Notification::Chrome {
        text: text.into(),
        icon: None,
    })
}

fn step_output(text: &str) -> AppEvent {
    AppEvent::Notification(Notification::StepOutput { text: text.into() })
}

fn outcome(state: AppState) -> SessionOutcome {
    match state {
        AppState::Exiting { outcome } => outcome,
        other => panic!("expected exiting, got {:?}", other.tag()),
    }
}

// ── thinking ─────────────────────────────────────────────────────

#[test]
fn thinking_final_low_command_auto_execs_as_model() {
    let next = reduce(&AppState::Thinking, &final_command(cmd("ls", "low")), false).unwrap();
    assert_eq!(
        outcome(next),
        SessionOutcome::Run {
            command: "ls".into(),
            response: cmd("ls", "low"),
            source: StepSource::Model,
        }
    );
}

#[test]
fn thinking_final_medium_and_high_open_confirming() {
    for risk in ["medium", "high"] {
        let next = reduce(&AppState::Thinking, &final_command(cmd("ls", risk)), false).unwrap();
        assert_eq!(next, confirming(cmd("ls", risk)), "{risk}");
    }
}

#[test]
fn thinking_non_final_low_never_auto_execs() {
    let next = reduce(
        &AppState::Thinking,
        &final_command(step("ls", "low")),
        false,
    )
    .unwrap();
    assert_eq!(next, confirming(step("ls", "low")));
}

#[test]
fn yolo_auto_execs_any_final_risk_from_thinking() {
    for risk in ["low", "medium", "high"] {
        let next = reduce(&AppState::Thinking, &final_command(cmd("ls", risk)), true).unwrap();
        assert!(
            matches!(
                outcome(next),
                SessionOutcome::Run {
                    source: StepSource::Model,
                    ..
                }
            ),
            "{risk}"
        );
    }
}

#[test]
fn thinking_answer_exhausted_error_and_block_exit() {
    let answer = reduce(
        &AppState::Thinking,
        &AppEvent::LoopFinal {
            result: LoopReturn::Answer("42".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(outcome(answer), SessionOutcome::Answer("42".into()));

    let exhausted = reduce(
        &AppState::Thinking,
        &AppEvent::LoopFinal {
            result: LoopReturn::Exhausted,
        },
        false,
    )
    .unwrap();
    assert_eq!(outcome(exhausted), SessionOutcome::Exhausted);

    let error = reduce(
        &AppState::Thinking,
        &AppEvent::LoopError {
            message: "boom".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(outcome(error), SessionOutcome::Error("boom".into()));

    let blocked = reduce(
        &AppState::Thinking,
        &AppEvent::Block {
            command: "echo x".into(),
            response: cmd("echo x", "medium"),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        outcome(blocked),
        SessionOutcome::Blocked {
            command: "echo x".into(),
            response: Some(cmd("echo x", "medium")),
        }
    );
}

#[test]
fn thinking_ignores_aborted_and_dialog_events() {
    let aborted = AppEvent::LoopFinal {
        result: LoopReturn::Aborted,
    };
    assert_eq!(reduce(&AppState::Thinking, &aborted, false), None);
    assert_eq!(
        reduce(
            &AppState::Thinking,
            &AppEvent::KeyAction(ActionId::Run),
            false
        ),
        None
    );
    assert_eq!(reduce(&AppState::Thinking, &AppEvent::KeyEsc, false), None);
}

// ── confirming ───────────────────────────────────────────────────

#[test]
fn confirming_run_on_final_command_exits_run_model() {
    let next = reduce(
        &confirming(cmd("ls -la", "medium")),
        &AppEvent::KeyAction(ActionId::Run),
        false,
    )
    .unwrap();
    assert_eq!(
        outcome(next),
        SessionOutcome::Run {
            command: "ls -la".into(),
            response: cmd("ls -la", "medium"),
            source: StepSource::Model,
        }
    );
}

#[test]
fn confirming_run_on_non_final_medium_enters_executing_step() {
    let next = reduce(
        &confirming_with_slot(step("echo probe", "medium"), "earlier"),
        &AppEvent::KeyAction(ActionId::Run),
        false,
    )
    .unwrap();
    assert_eq!(
        next,
        AppState::ExecutingStep {
            response: step("echo probe", "medium"),
            source: StepSource::Model,
            output_slot: Some("earlier".into()),
            answer: None,
        }
    );
}

#[test]
fn confirming_run_on_final_low_exits_rather_than_stepping() {
    let next = reduce(
        &confirming(cmd("ls", "low")),
        &AppEvent::KeyAction(ActionId::Run),
        false,
    )
    .unwrap();
    assert!(matches!(outcome(next), SessionOutcome::Run { .. }));
}

#[test]
fn confirming_cancel_and_esc_exit_cancel_with_response() {
    for event in [AppEvent::KeyAction(ActionId::Cancel), AppEvent::KeyEsc] {
        let next = reduce(&confirming(cmd("ls", "medium")), &event, false).unwrap();
        assert_eq!(
            outcome(next),
            SessionOutcome::Cancel {
                response: Some(cmd("ls", "medium")),
            }
        );
    }
}

#[test]
fn confirming_edit_seeds_draft_with_the_command() {
    let next = reduce(
        &confirming_with_slot(cmd("ls -la", "medium"), "out"),
        &AppEvent::KeyAction(ActionId::Edit),
        false,
    )
    .unwrap();
    assert_eq!(
        next,
        AppState::Editing {
            response: cmd("ls -la", "medium"),
            draft: "ls -la".into(),
            output_slot: Some("out".into()),
            answer: None,
        }
    );
}

#[test]
fn confirming_followup_opens_an_empty_composer() {
    let next = reduce(
        &confirming(cmd("ls", "medium")),
        &AppEvent::KeyAction(ActionId::Followup),
        false,
    )
    .unwrap();
    assert_eq!(next, composing(cmd("ls", "medium")));
}

#[test]
fn confirming_copy_is_a_no_op() {
    assert_eq!(
        reduce(
            &confirming(cmd("ls", "medium")),
            &AppEvent::KeyAction(ActionId::Copy),
            false
        ),
        None
    );
}

#[test]
fn confirming_late_step_output_lands_in_the_slot() {
    let next = reduce(
        &confirming(cmd("ls", "medium")),
        &step_output("late"),
        false,
    )
    .unwrap();
    assert_eq!(next, confirming_with_slot(cmd("ls", "medium"), "late"));
    assert_eq!(
        reduce(&confirming(cmd("ls", "medium")), &chrome("x"), false),
        None
    );
}

// ── editing ──────────────────────────────────────────────────────

#[test]
fn editing_esc_returns_to_confirming_with_the_original() {
    let next = reduce(&editing(cmd("ls", "medium")), &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(next, confirming(cmd("ls", "medium")));
}

#[test]
fn editing_submit_on_final_command_runs_the_override() {
    let next = reduce(
        &editing(cmd("ls", "medium")),
        &AppEvent::SubmitEdit {
            text: "ls -la".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        outcome(next),
        SessionOutcome::Run {
            command: "ls -la".into(),
            response: cmd("ls", "medium"),
            source: StepSource::UserOverride,
        }
    );
}

#[test]
fn editing_submit_on_non_final_medium_executes_the_edited_step() {
    let next = reduce(
        &editing(step("echo a", "medium")),
        &AppEvent::SubmitEdit {
            text: "echo b".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        next,
        AppState::ExecutingStep {
            response: step("echo b", "medium"),
            source: StepSource::UserOverride,
            output_slot: None,
            answer: None,
        }
    );
}

#[test]
fn editing_tracks_draft_changes_and_editor_handoff() {
    let changed = reduce(
        &editing(cmd("ls", "medium")),
        &AppEvent::DraftChange {
            text: "ls -a".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(changed.draft(), Some("ls -a"));

    let handoff = reduce(
        &editing(cmd("ls", "medium")),
        &AppEvent::EnterEditor {
            draft: "ls -a".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        handoff,
        AppState::EditorHandoff {
            origin: EditorOrigin::Editing,
            draft: "ls -a".into(),
            response: Some(cmd("ls", "medium")),
            output_slot: None,
            answer: None,
        }
    );
}

// ── composing-followup ───────────────────────────────────────────

#[test]
fn composing_esc_returns_to_confirming() {
    let next = reduce(&composing(cmd("ls", "medium")), &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(next, confirming(cmd("ls", "medium")));
}

#[test]
fn composing_submit_enters_processing_with_the_draft_and_no_status() {
    let next = reduce(
        &composing(cmd("ls", "medium")),
        &AppEvent::SubmitFollowup {
            text: "be safer".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(next, processing(cmd("ls", "medium")));
}

#[test]
fn composing_enter_editor_hands_off_with_origin_followup() {
    let next = reduce(
        &composing(cmd("ls", "medium")),
        &AppEvent::EnterEditor {
            draft: "partial".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        next,
        AppState::EditorHandoff {
            origin: EditorOrigin::ComposingFollowup,
            draft: "partial".into(),
            response: Some(cmd("ls", "medium")),
            output_slot: None,
            answer: None,
        }
    );
}

// ── processing-followup ──────────────────────────────────────────

#[test]
fn processing_esc_returns_to_composing_with_draft_preserved() {
    let next = reduce(&processing(cmd("ls", "medium")), &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(
        next,
        AppState::ComposingFollowup {
            response: cmd("ls", "medium"),
            draft: "be safer".into(),
            output_slot: None,
            answer: None,
        }
    );
}

#[test]
fn processing_routes_chrome_to_status_and_step_output_to_slot() {
    let with_status = reduce(&processing(cmd("ls", "medium")), &chrome("working"), false).unwrap();
    assert_eq!(with_status.status(), Some("working"));
    assert_eq!(with_status.draft(), Some("be safer"));

    let with_slot = reduce(
        &processing(cmd("ls", "medium")),
        &step_output("body"),
        false,
    )
    .unwrap();
    assert_eq!(with_slot.output_slot(), Some("body"));

    let verbose = AppEvent::Notification(Notification::Verbose { line: "x".into() });
    assert_eq!(
        reduce(&processing(cmd("ls", "medium")), &verbose, false),
        None
    );
}

#[test]
fn processing_final_low_opens_confirming_instead_of_auto_exec() {
    let state = AppState::ProcessingFollowup {
        response: cmd("ls", "medium"),
        draft: "d".into(),
        status: None,
        output_slot: Some("kept".into()),
        answer: None,
    };
    let next = reduce(&state, &final_command(cmd("ls -a", "low")), false).unwrap();
    assert_eq!(next, confirming_with_slot(cmd("ls -a", "low"), "kept"));
    let yolo = reduce(&state, &final_command(cmd("ls -a", "low")), true).unwrap();
    assert_eq!(yolo, confirming_with_slot(cmd("ls -a", "low"), "kept"));
}

#[test]
fn processing_answer_keeps_the_pending_command() {
    let proposal = cmd("echo proposed", "medium");
    let state = processing(proposal.clone());
    let next = reduce(
        &state,
        &AppEvent::LoopFinal {
            result: LoopReturn::Answer("It is an API identifier.".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(next.tag(), wrap::session::state::StateTag::Confirming);
    assert_eq!(next.response(), Some(&proposal));
    assert_eq!(next.answer(), Some("It is an API identifier."));
    let run = reduce(&next, &AppEvent::KeyAction(ActionId::Run), false).unwrap();
    assert_eq!(
        outcome(run),
        SessionOutcome::Run {
            command: proposal.content.clone(),
            response: proposal,
            source: StepSource::Model,
        }
    );
}

#[test]
fn followup_answer_survives_editing_editor_handoff_and_cancelled_questions() {
    let proposal = step("echo proposed", "medium");
    let mut state = AppState::Confirming {
        response: proposal.clone(),
        output_slot: Some("discovery output".into()),
        answer: Some("It is an API identifier.".into()),
    };
    for action in [ActionId::Edit, ActionId::Followup] {
        for event in [
            AppEvent::KeyAction(action),
            AppEvent::DraftChange {
                text: "draft".into(),
            },
            AppEvent::EnterEditor {
                draft: "draft".into(),
            },
            AppEvent::EditorDone {
                text: Some("edited draft".into()),
            },
            AppEvent::KeyEsc,
        ] {
            state = reduce(&state, &event, false).unwrap();
            assert_eq!(state.answer(), Some("It is an API identifier."));
            assert_eq!(state.output_slot(), Some("discovery output"));
        }
    }
    for event in [
        AppEvent::KeyAction(ActionId::Followup),
        AppEvent::SubmitFollowup {
            text: "Explain more".into(),
        },
        chrome("working"),
        AppEvent::KeyEsc,
        AppEvent::SubmitFollowup {
            text: "Explain more".into(),
        },
    ] {
        state = reduce(&state, &event, false).unwrap();
        assert_eq!(state.answer(), Some("It is an API identifier."));
    }
    state = reduce(
        &state,
        &AppEvent::LoopFinal {
            result: LoopReturn::Answer("More detail.".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(state.answer(), Some("More detail."));
    state = reduce(&state, &step_output("late output"), false).unwrap();
    assert_eq!(state.answer(), Some("More detail."));
    state = reduce(&state, &AppEvent::KeyAction(ActionId::Run), false).unwrap();
    assert_eq!(state.answer(), Some("More detail."));
    state = reduce(&state, &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(state.response(), Some(&proposal));
    assert_eq!(state.answer(), Some("More detail."));
    state = reduce(&state, &AppEvent::KeyAction(ActionId::Followup), false).unwrap();
    state = reduce(
        &state,
        &AppEvent::SubmitFollowup {
            text: "Change it".into(),
        },
        false,
    )
    .unwrap();
    state = reduce(
        &state,
        &final_command(cmd("echo replacement", "low")),
        false,
    )
    .unwrap();
    assert_eq!(state.answer(), None);
    assert_eq!(state.response().unwrap().content, "echo replacement");
    assert_eq!(state.tag(), wrap::session::state::StateTag::Confirming);
}

#[test]
fn explicitly_abandoning_the_command_exits_with_the_answer() {
    let next = reduce(
        &processing(cmd("echo proposed", "medium")),
        &AppEvent::LoopFinal {
            result: LoopReturn::AnswerOnly("Just the explanation.".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        outcome(next),
        SessionOutcome::Answer("Just the explanation.".into())
    );
}

#[test]
fn processing_exhausted_and_error_exit_but_aborted_is_dropped() {
    let state = processing(cmd("ls", "medium"));
    let exhausted = reduce(
        &state,
        &AppEvent::LoopFinal {
            result: LoopReturn::Exhausted,
        },
        false,
    )
    .unwrap();
    assert_eq!(outcome(exhausted), SessionOutcome::Exhausted);
    let error = reduce(
        &state,
        &AppEvent::LoopError {
            message: "bad".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(outcome(error), SessionOutcome::Error("bad".into()));
    assert_eq!(
        reduce(
            &state,
            &AppEvent::LoopFinal {
                result: LoopReturn::Aborted
            },
            false
        ),
        None
    );
}

// ── executing-step ───────────────────────────────────────────────

#[test]
fn executing_step_esc_returns_to_confirming_keeping_the_slot() {
    let state = AppState::ExecutingStep {
        response: step("echo a", "medium"),
        source: StepSource::UserOverride,
        output_slot: Some("prior".into()),
        answer: None,
    };
    let next = reduce(&state, &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(
        next,
        confirming_with_slot(step("echo a", "medium"), "prior")
    );
}

#[test]
fn executing_step_takes_step_output_but_ignores_chrome() {
    let state = executing(step("echo a", "medium"));
    let next = reduce(&state, &step_output("captured"), false).unwrap();
    assert_eq!(next.output_slot(), Some("captured"));
    assert_eq!(next.tag(), state.tag());
    assert_eq!(reduce(&state, &chrome("ignored"), false), None);
}

#[test]
fn executing_step_final_command_lands_in_confirming_with_the_slot() {
    let state = AppState::ExecutingStep {
        response: step("echo a", "medium"),
        source: StepSource::Model,
        output_slot: Some("out".into()),
        answer: None,
    };
    let next = reduce(&state, &final_command(cmd("echo done", "low")), false).unwrap();
    assert_eq!(next, confirming_with_slot(cmd("echo done", "low"), "out"));
}

#[test]
fn executing_step_reply_exhausted_error_exit_and_aborted_is_dropped() {
    let state = executing(step("echo a", "medium"));
    assert_eq!(
        outcome(
            reduce(
                &state,
                &AppEvent::LoopFinal {
                    result: LoopReturn::Answer("a".into())
                },
                false
            )
            .unwrap()
        ),
        SessionOutcome::Answer("a".into())
    );
    assert_eq!(
        outcome(
            reduce(
                &state,
                &AppEvent::LoopFinal {
                    result: LoopReturn::Exhausted
                },
                false
            )
            .unwrap()
        ),
        SessionOutcome::Exhausted
    );
    assert_eq!(
        outcome(
            reduce(
                &state,
                &AppEvent::LoopError {
                    message: "e".into()
                },
                false
            )
            .unwrap()
        ),
        SessionOutcome::Error("e".into())
    );
    assert_eq!(
        reduce(
            &state,
            &AppEvent::LoopFinal {
                result: LoopReturn::Aborted
            },
            false
        ),
        None
    );
}

// ── composing-interactive / processing-interactive ───────────────

#[test]
fn composing_interactive_transitions() {
    let state = AppState::ComposingInteractive {
        draft: String::new(),
    };
    let typed = reduce(
        &state,
        &AppEvent::DraftChange {
            text: "find ts".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(typed.draft(), Some("find ts"));

    let submitted = reduce(
        &state,
        &AppEvent::SubmitInteractive {
            text: "find ts".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        submitted,
        AppState::ProcessingInteractive {
            draft: "find ts".into(),
            status: None,
        }
    );

    let cancelled = reduce(&state, &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(
        outcome(cancelled),
        SessionOutcome::Cancel { response: None }
    );

    let handoff = reduce(
        &state,
        &AppEvent::EnterEditor {
            draft: "partial".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        handoff,
        AppState::EditorHandoff {
            origin: EditorOrigin::ComposingInteractive,
            draft: "partial".into(),
            response: None,
            output_slot: None,
            answer: None,
        }
    );
}

#[test]
fn processing_interactive_mirrors_the_initial_path() {
    let state = AppState::ProcessingInteractive {
        draft: "find ts".into(),
        status: None,
    };
    let esc = reduce(&state, &AppEvent::KeyEsc, false).unwrap();
    assert_eq!(
        esc,
        AppState::ComposingInteractive {
            draft: "find ts".into()
        }
    );
    let status = reduce(&state, &chrome("probing"), false).unwrap();
    assert_eq!(status.status(), Some("probing"));

    let low = reduce(&state, &final_command(cmd("ls", "low")), false).unwrap();
    assert!(matches!(outcome(low), SessionOutcome::Run { .. }));
    let medium = reduce(&state, &final_command(cmd("ls", "medium")), false).unwrap();
    assert_eq!(medium, confirming(cmd("ls", "medium")));
    let yolo_medium = reduce(&state, &final_command(cmd("ls", "medium")), true).unwrap();
    assert!(matches!(outcome(yolo_medium), SessionOutcome::Run { .. }));

    assert_eq!(
        outcome(
            reduce(
                &state,
                &AppEvent::LoopFinal {
                    result: LoopReturn::Answer("a".into())
                },
                false
            )
            .unwrap()
        ),
        SessionOutcome::Answer("a".into())
    );
    assert_eq!(
        outcome(
            reduce(
                &state,
                &AppEvent::LoopFinal {
                    result: LoopReturn::Exhausted
                },
                false
            )
            .unwrap()
        ),
        SessionOutcome::Exhausted
    );
    assert_eq!(
        outcome(
            reduce(
                &state,
                &AppEvent::LoopError {
                    message: "e".into()
                },
                false
            )
            .unwrap()
        ),
        SessionOutcome::Error("e".into())
    );
    assert_eq!(
        reduce(
            &state,
            &AppEvent::LoopFinal {
                result: LoopReturn::Aborted
            },
            false
        ),
        None
    );
    let verbose = AppEvent::Notification(Notification::Verbose { line: "x".into() });
    assert_eq!(reduce(&state, &verbose, false), None);
}

// ── editor-handoff ───────────────────────────────────────────────

#[test]
fn editor_done_restores_the_origin_with_new_or_preserved_draft() {
    let interactive = AppState::EditorHandoff {
        origin: EditorOrigin::ComposingInteractive,
        draft: "old".into(),
        response: None,
        output_slot: None,
        answer: None,
    };
    let replaced = reduce(
        &interactive,
        &AppEvent::EditorDone {
            text: Some("new".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        replaced,
        AppState::ComposingInteractive {
            draft: "new".into()
        }
    );
    let kept = reduce(&interactive, &AppEvent::EditorDone { text: None }, false).unwrap();
    assert_eq!(
        kept,
        AppState::ComposingInteractive {
            draft: "old".into()
        }
    );

    let followup = AppState::EditorHandoff {
        origin: EditorOrigin::ComposingFollowup,
        draft: "old".into(),
        response: Some(cmd("ls", "medium")),
        output_slot: Some("slot".into()),
        answer: None,
    };
    let restored = reduce(
        &followup,
        &AppEvent::EditorDone {
            text: Some("new".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        restored,
        AppState::ComposingFollowup {
            response: cmd("ls", "medium"),
            draft: "new".into(),
            output_slot: Some("slot".into()),
            answer: None,
        }
    );

    let editing_origin = AppState::EditorHandoff {
        origin: EditorOrigin::Editing,
        draft: "ls".into(),
        response: Some(cmd("ls", "medium")),
        output_slot: None,
        answer: None,
    };
    let restored = reduce(
        &editing_origin,
        &AppEvent::EditorDone {
            text: Some("ls -la".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        restored,
        AppState::Editing {
            response: cmd("ls", "medium"),
            draft: "ls -la".into(),
            output_slot: None,
            answer: None,
        }
    );
}

#[test]
fn editor_handoff_ignores_esc_and_a_missing_response_keeps_the_state() {
    let state = AppState::EditorHandoff {
        origin: EditorOrigin::Editing,
        draft: "ls".into(),
        response: None,
        output_slot: None,
        answer: None,
    };
    assert_eq!(reduce(&state, &AppEvent::KeyEsc, false), None);
    assert_eq!(
        reduce(
            &state,
            &AppEvent::EditorDone {
                text: Some("x".into())
            },
            false
        ),
        None
    );
}

// ── exiting / purity ─────────────────────────────────────────────

#[test]
fn exiting_absorbs_everything() {
    let state = AppState::Exiting {
        outcome: SessionOutcome::Exhausted,
    };
    assert_eq!(reduce(&state, &AppEvent::KeyEsc, false), None);
    assert_eq!(
        reduce(&state, &final_command(cmd("ls", "low")), false),
        None
    );
}

#[test]
fn reduce_is_deterministic_and_leaves_the_input_untouched() {
    let state = confirming(cmd("ls", "medium"));
    let event = AppEvent::KeyAction(ActionId::Edit);
    let first = reduce(&state, &event, false);
    let second = reduce(&state, &event, false);
    assert_eq!(first, second);
    assert_eq!(state, confirming(cmd("ls", "medium")));
    assert_eq!(
        reduce(&state, &AppEvent::SubmitEdit { text: "x".into() }, false),
        None
    );
    assert_eq!(
        reduce(
            &composing(reply("x")),
            &AppEvent::KeyAction(ActionId::Run),
            false
        ),
        None
    );
}
