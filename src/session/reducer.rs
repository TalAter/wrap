//! The pure state machine. Every (state, event) pair has a defined
//! transition; pairs that mean nothing in the current state yield `None` so
//! the coordinator can short-circuit.
//!
//! Side effects (cancelling an in-flight loop, restarting it, mounting the
//! dialog, executing the command) live in the coordinator, which observes
//! state changes and triggers them.

use super::state::{
    ActionId, AppEvent, AppState, EditorOrigin, LoopReturn, SessionOutcome, StepSource,
};
use crate::chrome::Notification;
use crate::response::{CommandResponse, RiskLevel};

/// `yolo` bypasses the confirmation dialog for the initial response. It is
/// fixed for the whole session, so transitions stay deterministic per run.
pub fn reduce(state: &AppState, event: &AppEvent, yolo: bool) -> Option<AppState> {
    match state {
        AppState::Thinking => reduce_thinking(event, yolo),
        AppState::Confirming {
            response,
            output_slot,
            answer,
        } => reduce_confirming(response, output_slot, answer, event),
        AppState::Editing {
            response,
            output_slot,
            answer,
            ..
        } => reduce_editing(response, output_slot, answer, event),
        AppState::ComposingFollowup {
            response,
            output_slot,
            answer,
            ..
        } => reduce_composing(response, output_slot, answer, event),
        AppState::ProcessingFollowup {
            response,
            draft,
            status,
            output_slot,
            answer,
        } => reduce_processing(response, draft, status, output_slot, answer, event),
        AppState::ComposingInteractive { .. } => reduce_composing_interactive(event),
        AppState::ProcessingInteractive { draft, .. } => {
            reduce_processing_interactive(draft, event, yolo)
        }
        AppState::EditorHandoff {
            origin,
            draft,
            response,
            output_slot,
            answer,
        } => reduce_editor_handoff(*origin, draft, response, output_slot, answer, event),
        AppState::ExecutingStep {
            response,
            source,
            output_slot,
            answer,
        } => reduce_executing_step(response, *source, output_slot, answer, event),
        AppState::Exiting { .. } => None,
    }
}

/// A non-final response above low risk needs the user to confirm the step.
fn is_non_final_confirm(response: &CommandResponse) -> bool {
    !response.is_final && response.risk_level != RiskLevel::Low
}

fn exiting(outcome: SessionOutcome) -> Option<AppState> {
    Some(AppState::Exiting { outcome })
}

fn run_model(response: &CommandResponse) -> Option<AppState> {
    exiting(SessionOutcome::Run {
        command: response.content.clone(),
        response: response.clone(),
        source: StepSource::Model,
    })
}

fn confirming(
    response: &CommandResponse,
    output_slot: &Option<String>,
    answer: &Option<String>,
) -> Option<AppState> {
    Some(AppState::Confirming {
        response: response.clone(),
        output_slot: output_slot.clone(),
        answer: answer.clone(),
    })
}

fn error(message: &str) -> Option<AppState> {
    exiting(SessionOutcome::Error(message.to_string()))
}

/// The initial-loop routing shared by `thinking` and `processing-interactive`:
/// a final low-risk command (any risk under yolo) runs straight away, the
/// rest open the dialog. A non-final response never auto-execs here.
fn route_initial_final(result: &LoopReturn, yolo: bool) -> Option<AppState> {
    match result {
        LoopReturn::Command(response) => {
            let auto_exec = response.risk_level == RiskLevel::Low || yolo;
            if auto_exec && response.is_final {
                run_model(response)
            } else {
                confirming(response, &None, &None)
            }
        }
        LoopReturn::Answer(content) | LoopReturn::AnswerOnly(content) => {
            exiting(SessionOutcome::Answer(content.clone()))
        }
        LoopReturn::Exhausted => exiting(SessionOutcome::Exhausted),
        LoopReturn::Aborted => None,
    }
}

/// Routing while a dialog is already up: even a low-risk command lands in
/// `confirming`, because the user is mid-refinement and expects to see it.
fn route_dialog_final(result: &LoopReturn, output_slot: &Option<String>) -> Option<AppState> {
    match result {
        LoopReturn::Command(response) => confirming(response, output_slot, &None),
        LoopReturn::Answer(content) | LoopReturn::AnswerOnly(content) => {
            exiting(SessionOutcome::Answer(content.clone()))
        }
        LoopReturn::Exhausted => exiting(SessionOutcome::Exhausted),
        LoopReturn::Aborted => None,
    }
}

fn reduce_thinking(event: &AppEvent, yolo: bool) -> Option<AppState> {
    match event {
        AppEvent::LoopFinal { result } => route_initial_final(result, yolo),
        AppEvent::LoopError { message } => error(message),
        AppEvent::Block { command, response } => exiting(SessionOutcome::Blocked {
            command: command.clone(),
            response: Some(response.clone()),
        }),
        _ => None,
    }
}

fn reduce_confirming(
    response: &CommandResponse,
    output_slot: &Option<String>,
    answer: &Option<String>,
    event: &AppEvent,
) -> Option<AppState> {
    match event {
        AppEvent::KeyAction(ActionId::Run) => {
            if is_non_final_confirm(response) {
                Some(AppState::ExecutingStep {
                    response: response.clone(),
                    source: StepSource::Model,
                    output_slot: output_slot.clone(),
                    answer: answer.clone(),
                })
            } else {
                run_model(response)
            }
        }
        AppEvent::KeyAction(ActionId::Cancel) | AppEvent::KeyEsc => {
            exiting(SessionOutcome::Cancel {
                response: Some(response.clone()),
            })
        }
        AppEvent::KeyAction(ActionId::Edit) => Some(AppState::Editing {
            response: response.clone(),
            draft: response.content.clone(),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        AppEvent::KeyAction(ActionId::Followup) => Some(AppState::ComposingFollowup {
            response: response.clone(),
            draft: String::new(),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        AppEvent::KeyAction(ActionId::Copy) => None,
        // A step's output can land after the transition to confirming (a
        // racing flush); the slot still shows the latest output.
        AppEvent::Notification(Notification::StepOutput { text }) => Some(AppState::Confirming {
            response: response.clone(),
            output_slot: Some(text.clone()),
            answer: answer.clone(),
        }),
        _ => None,
    }
}

fn reduce_editing(
    response: &CommandResponse,
    output_slot: &Option<String>,
    answer: &Option<String>,
    event: &AppEvent,
) -> Option<AppState> {
    match event {
        AppEvent::KeyEsc => confirming(response, output_slot, answer),
        AppEvent::SubmitEdit { text } => {
            if is_non_final_confirm(response) {
                // The response carries the edited bytes so the step captures
                // like a model-authored one; the prior assistant turn keeps
                // the original for audit.
                Some(AppState::ExecutingStep {
                    response: CommandResponse {
                        content: text.clone(),
                        ..response.clone()
                    },
                    source: StepSource::UserOverride,
                    output_slot: output_slot.clone(),
                    answer: answer.clone(),
                })
            } else {
                exiting(SessionOutcome::Run {
                    command: text.clone(),
                    response: response.clone(),
                    source: StepSource::UserOverride,
                })
            }
        }
        AppEvent::DraftChange { text } => Some(AppState::Editing {
            response: response.clone(),
            draft: text.clone(),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        AppEvent::EnterEditor { draft: handoff } => Some(AppState::EditorHandoff {
            origin: EditorOrigin::Editing,
            draft: handoff.clone(),
            response: Some(response.clone()),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        _ => None,
    }
}

fn reduce_composing(
    response: &CommandResponse,
    output_slot: &Option<String>,
    answer: &Option<String>,
    event: &AppEvent,
) -> Option<AppState> {
    match event {
        AppEvent::KeyEsc => confirming(response, output_slot, answer),
        AppEvent::DraftChange { text } => Some(AppState::ComposingFollowup {
            response: response.clone(),
            draft: text.clone(),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        AppEvent::SubmitFollowup { text } => Some(AppState::ProcessingFollowup {
            response: response.clone(),
            draft: text.clone(),
            status: None,
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        AppEvent::EnterEditor { draft: handoff } => Some(AppState::EditorHandoff {
            origin: EditorOrigin::ComposingFollowup,
            draft: handoff.clone(),
            response: Some(response.clone()),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        _ => None,
    }
}

fn reduce_processing(
    response: &CommandResponse,
    draft: &str,
    status: &Option<String>,
    output_slot: &Option<String>,
    answer: &Option<String>,
    event: &AppEvent,
) -> Option<AppState> {
    let with = |status: Option<String>, output_slot: Option<String>| {
        Some(AppState::ProcessingFollowup {
            response: response.clone(),
            draft: draft.to_string(),
            status,
            output_slot,
            answer: answer.clone(),
        })
    };
    match event {
        AppEvent::KeyEsc => Some(AppState::ComposingFollowup {
            response: response.clone(),
            draft: draft.to_string(),
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        AppEvent::Notification(Notification::Chrome { text, .. }) => {
            with(Some(text.clone()), output_slot.clone())
        }
        AppEvent::Notification(Notification::StepOutput { text }) => {
            with(status.clone(), Some(text.clone()))
        }
        AppEvent::LoopFinal {
            result: LoopReturn::Answer(content),
        } => confirming(response, output_slot, &Some(content.clone())),
        AppEvent::LoopFinal { result } => route_dialog_final(result, output_slot),
        AppEvent::LoopError { message } => error(message),
        _ => None,
    }
}

fn reduce_composing_interactive(event: &AppEvent) -> Option<AppState> {
    match event {
        AppEvent::KeyEsc => exiting(SessionOutcome::Cancel { response: None }),
        AppEvent::DraftChange { text } => Some(AppState::ComposingInteractive {
            draft: text.clone(),
        }),
        AppEvent::SubmitInteractive { text } => Some(AppState::ProcessingInteractive {
            draft: text.clone(),
            status: None,
        }),
        AppEvent::EnterEditor { draft: handoff } => Some(AppState::EditorHandoff {
            origin: EditorOrigin::ComposingInteractive,
            draft: handoff.clone(),
            response: None,
            output_slot: None,
            answer: None,
        }),
        _ => None,
    }
}

fn reduce_processing_interactive(draft: &str, event: &AppEvent, yolo: bool) -> Option<AppState> {
    match event {
        AppEvent::KeyEsc => Some(AppState::ComposingInteractive {
            draft: draft.to_string(),
        }),
        AppEvent::Notification(Notification::Chrome { text, .. }) => {
            Some(AppState::ProcessingInteractive {
                draft: draft.to_string(),
                status: Some(text.clone()),
            })
        }
        // The interactive submit is the user's first turn, so it routes like
        // the argv path: a final low auto-execs, the rest confirm.
        AppEvent::LoopFinal { result } => route_initial_final(result, yolo),
        AppEvent::LoopError { message } => error(message),
        _ => None,
    }
}

/// The editor owns Esc; only `editor-done` moves on, back to the origin with
/// the new draft or the one the user had.
fn reduce_editor_handoff(
    origin: EditorOrigin,
    draft: &str,
    response: &Option<CommandResponse>,
    output_slot: &Option<String>,
    answer: &Option<String>,
    event: &AppEvent,
) -> Option<AppState> {
    let AppEvent::EditorDone { text } = event else {
        return None;
    };
    let new_draft = text.clone().unwrap_or_else(|| draft.to_string());
    match origin {
        EditorOrigin::ComposingInteractive => {
            Some(AppState::ComposingInteractive { draft: new_draft })
        }
        EditorOrigin::ComposingFollowup => Some(AppState::ComposingFollowup {
            response: response.clone()?,
            draft: new_draft,
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
        EditorOrigin::Editing => Some(AppState::Editing {
            response: response.clone()?,
            draft: new_draft,
            output_slot: output_slot.clone(),
            answer: answer.clone(),
        }),
    }
}

/// The confirmed-step mirror of `processing`: the dialog stays mounted while
/// the coordinator captures the step and runs the next round. Esc bails out
/// to `confirming` so the user can re-review or cancel.
fn reduce_executing_step(
    response: &CommandResponse,
    source: StepSource,
    output_slot: &Option<String>,
    answer: &Option<String>,
    event: &AppEvent,
) -> Option<AppState> {
    match event {
        AppEvent::KeyEsc => confirming(response, output_slot, answer),
        AppEvent::Notification(Notification::StepOutput { text }) => {
            Some(AppState::ExecutingStep {
                response: response.clone(),
                source,
                output_slot: Some(text.clone()),
                answer: answer.clone(),
            })
        }
        AppEvent::LoopFinal { result } => route_dialog_final(result, output_slot),
        AppEvent::LoopError { message } => error(message),
        _ => None,
    }
}
