use serde::{Deserialize, Serialize};

/// How a reply failed to become a schema-valid value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseReason {
    InvalidJson,
    InvalidSchema,
}

/// Operational outcomes of a send. Messages are bare plain language; the
/// surfacing site adds its category prefix.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LlmError {
    /// The reply could not be turned into a schema-valid value, even after
    /// the corrective retry. Carries the last raw text.
    #[error("{message}")]
    Parse {
        message: String,
        raw_text: String,
        reason: ParseReason,
    },
    /// The transport or provider failed before a usable reply existed.
    #[error("{message}")]
    Provider { message: String },
    /// The send's cancellation token fired; the entry was sealed at that moment.
    #[error("Send aborted.")]
    Aborted,
}
