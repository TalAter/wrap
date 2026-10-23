//! The session's state machine vocabulary: every state the dialog can be in,
//! every event the reducer accepts, and the outcome a session ends with.

use serde::{Deserialize, Serialize};

use crate::chrome::Notification;
use crate::response::CommandResponse;

/// Who authored the command a step or final run executes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepSource {
    /// Exactly what the model produced.
    Model,
    /// The user edited the command before confirming it.
    UserOverride,
}

impl StepSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::UserOverride => "user_override",
        }
    }
}

/// The dialog state an external-editor handoff returns to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorOrigin {
    ComposingInteractive,
    ComposingFollowup,
    Editing,
}

/// Discriminant of [`AppState`], for transition bookkeeping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StateTag {
    Thinking,
    Confirming,
    Editing,
    ComposingFollowup,
    ProcessingFollowup,
    ComposingInteractive,
    ProcessingInteractive,
    EditorHandoff,
    ExecutingStep,
    Exiting,
}

/// True when the state should have the response dialog mounted. Editor
/// handoff is deliberately excluded: a terminal-owning editor needs the
/// alternate screen released so the child can own the TTY.
pub fn is_dialog_tag(tag: StateTag) -> bool {
    matches!(
        tag,
        StateTag::Confirming
            | StateTag::Editing
            | StateTag::ComposingFollowup
            | StateTag::ProcessingFollowup
            | StateTag::ComposingInteractive
            | StateTag::ProcessingInteractive
            | StateTag::ExecutingStep
    )
}

/// Everything the session can be doing. The dialog reads command, risk and
/// explanation off `response`; drafts are the live edit/compose buffers; the
/// output slot is the last captured step output and survives every
/// transition within one dialog lifetime.
#[derive(Clone, Debug, PartialEq)]
pub enum AppState {
    /// Pre-dialog: the stderr spinner is showing while the first final-form
    /// response is pending. Initial state of every session.
    Thinking,
    Confirming {
        response: CommandResponse,
        output_slot: Option<String>,
    },
    Editing {
        response: CommandResponse,
        draft: String,
        output_slot: Option<String>,
    },
    ComposingFollowup {
        response: CommandResponse,
        draft: String,
        output_slot: Option<String>,
    },
    ProcessingFollowup {
        response: CommandResponse,
        draft: String,
        /// Latest chrome line, shown in the bottom border.
        status: Option<String>,
        output_slot: Option<String>,
    },
    /// The very first prompt typed into the interactive composer.
    ComposingInteractive {
        draft: String,
    },
    /// First LLM round in flight after an interactive submit.
    ProcessingInteractive {
        draft: String,
        status: Option<String>,
    },
    /// A terminal-owning external editor holds the TTY; the dialog is
    /// unmounted until the coordinator reports the editor finished.
    EditorHandoff {
        origin: EditorOrigin,
        draft: String,
        response: Option<CommandResponse>,
        output_slot: Option<String>,
    },
    /// A confirmed non-final step is running in capture mode.
    ExecutingStep {
        response: CommandResponse,
        source: StepSource,
        output_slot: Option<String>,
    },
    Exiting {
        outcome: SessionOutcome,
    },
}

impl AppState {
    pub fn tag(&self) -> StateTag {
        match self {
            Self::Thinking => StateTag::Thinking,
            Self::Confirming { .. } => StateTag::Confirming,
            Self::Editing { .. } => StateTag::Editing,
            Self::ComposingFollowup { .. } => StateTag::ComposingFollowup,
            Self::ProcessingFollowup { .. } => StateTag::ProcessingFollowup,
            Self::ComposingInteractive { .. } => StateTag::ComposingInteractive,
            Self::ProcessingInteractive { .. } => StateTag::ProcessingInteractive,
            Self::EditorHandoff { .. } => StateTag::EditorHandoff,
            Self::ExecutingStep { .. } => StateTag::ExecutingStep,
            Self::Exiting { .. } => StateTag::Exiting,
        }
    }

    pub fn is_dialog(&self) -> bool {
        is_dialog_tag(self.tag())
    }

    /// The model response the dialog is showing, when the state carries one.
    pub fn response(&self) -> Option<&CommandResponse> {
        match self {
            Self::Confirming { response, .. }
            | Self::Editing { response, .. }
            | Self::ComposingFollowup { response, .. }
            | Self::ProcessingFollowup { response, .. }
            | Self::ExecutingStep { response, .. } => Some(response),
            Self::EditorHandoff { response, .. } => response.as_ref(),
            _ => None,
        }
    }

    /// The live edit or compose buffer, when the state has one.
    pub fn draft(&self) -> Option<&str> {
        match self {
            Self::Editing { draft, .. }
            | Self::ComposingFollowup { draft, .. }
            | Self::ProcessingFollowup { draft, .. }
            | Self::ComposingInteractive { draft }
            | Self::ProcessingInteractive { draft, .. }
            | Self::EditorHandoff { draft, .. } => Some(draft),
            _ => None,
        }
    }

    pub fn output_slot(&self) -> Option<&str> {
        match self {
            Self::Confirming { output_slot, .. }
            | Self::Editing { output_slot, .. }
            | Self::ComposingFollowup { output_slot, .. }
            | Self::ProcessingFollowup { output_slot, .. }
            | Self::EditorHandoff { output_slot, .. }
            | Self::ExecutingStep { output_slot, .. } => output_slot.as_deref(),
            _ => None,
        }
    }

    /// The bottom-border status while a follow-up or interactive round runs.
    pub fn status(&self) -> Option<&str> {
        match self {
            Self::ProcessingFollowup { status, .. }
            | Self::ProcessingInteractive { status, .. } => status.as_deref(),
            _ => None,
        }
    }
}

/// How one LLM loop ended.
#[derive(Clone, Debug, PartialEq)]
pub enum LoopReturn {
    Command(CommandResponse),
    Answer(String),
    Exhausted,
    /// The loop noticed cancellation and bailed before a final response.
    Aborted,
}

/// What the session does on its way out.
#[derive(Clone, Debug, PartialEq)]
pub enum SessionOutcome {
    /// Exec `command` with inherited stdio. `source` tells a model command
    /// from a user-edited override; `response` is the model's original.
    Run {
        command: String,
        response: CommandResponse,
        source: StepSource,
    },
    /// Print to stdout.
    Answer(String),
    /// User-initiated abort; exits 0.
    Cancel {
        response: Option<CommandResponse>,
    },
    /// No TTY to confirm on; exits 1.
    Blocked {
        command: String,
        response: Option<CommandResponse>,
    },
    /// Round budget ran out without a final response; exits 1.
    Exhausted,
    Error(String),
}

/// Action bar items in `confirming`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionId {
    Run,
    Cancel,
    Edit,
    Followup,
    Copy,
}

/// Everything the reducer accepts.
#[derive(Clone, Debug, PartialEq)]
pub enum AppEvent {
    LoopFinal {
        result: LoopReturn,
    },
    LoopError {
        message: String,
    },
    /// The coordinator would mount the dialog but stderr is not a TTY.
    Block {
        command: String,
        response: CommandResponse,
    },
    Notification(Notification),
    KeyAction(ActionId),
    KeyEsc,
    SubmitEdit {
        text: String,
    },
    SubmitFollowup {
        text: String,
    },
    SubmitInteractive {
        text: String,
    },
    DraftChange {
        text: String,
    },
    /// Ctrl-G on a terminal-owning editor.
    EnterEditor {
        draft: String,
    },
    /// The editor child exited; `None` keeps the buffer the user had.
    EditorDone {
        text: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::response::{ResponseType, RiskLevel};

    fn response() -> CommandResponse {
        CommandResponse {
            scratchpad: None,
            kind: ResponseType::Command,
            is_final: true,
            plan: None,
            content: "echo hi".into(),
            risk_level: RiskLevel::Medium,
            explanation: None,
            memory_updates: None,
            memory_updates_message: None,
            watchlist_additions: None,
        }
    }

    #[test]
    fn only_the_seven_visible_states_mount_the_dialog() {
        let visible = [
            AppState::Confirming {
                response: response(),
                output_slot: None,
            },
            AppState::Editing {
                response: response(),
                draft: String::new(),
                output_slot: None,
            },
            AppState::ComposingFollowup {
                response: response(),
                draft: String::new(),
                output_slot: None,
            },
            AppState::ProcessingFollowup {
                response: response(),
                draft: String::new(),
                status: None,
                output_slot: None,
            },
            AppState::ComposingInteractive {
                draft: String::new(),
            },
            AppState::ProcessingInteractive {
                draft: String::new(),
                status: None,
            },
            AppState::ExecutingStep {
                response: response(),
                source: StepSource::Model,
                output_slot: None,
            },
        ];
        for state in visible {
            assert!(state.is_dialog(), "{:?}", state.tag());
        }
        for state in [
            AppState::Thinking,
            AppState::EditorHandoff {
                origin: EditorOrigin::Editing,
                draft: String::new(),
                response: None,
                output_slot: None,
            },
            AppState::Exiting {
                outcome: SessionOutcome::Exhausted,
            },
        ] {
            assert!(!state.is_dialog(), "{:?}", state.tag());
        }
    }

    #[test]
    fn step_source_serializes_as_the_log_vocabulary() {
        assert_eq!(
            serde_json::to_string(&StepSource::UserOverride).unwrap(),
            "\"user_override\""
        );
        assert_eq!(StepSource::Model.as_str(), "model");
    }
}
