//! The model's structured reply: a shell command or a text answer, plus the
//! risk classification and the side-channel fields (memory facts, watchlist
//! additions) the runner actions after each round.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseType {
    Command,
    Reply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryUpdate {
    pub fact: String,
    pub scope: String,
}

/// Field order matches the wire schema (`_scratchpad` first) so serialized
/// echoes and logs read the same way the model wrote them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandResponse {
    #[serde(
        rename = "_scratchpad",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub scratchpad: Option<String>,
    #[serde(rename = "type")]
    pub kind: ResponseType,
    #[serde(rename = "final", default = "default_true")]
    pub is_final: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub content: String,
    pub risk_level: RiskLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_updates: Option<Vec<MemoryUpdate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_updates_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watchlist_additions: Option<Vec<String>>,
}

fn default_true() -> bool {
    true
}

fn nullable(inner: Value) -> Value {
    json!({"anyOf": [inner, {"type": "null"}]})
}

/// JSON Schema describing [`CommandResponse`] for providers and attempt
/// forensics. Property order follows the schema source in `prompt/schema.txt`.
pub fn command_response_json_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "_scratchpad": nullable(json!({"type": "string"})),
                "type": {"type": "string", "enum": ["command", "reply"]},
                "final": {"default": true, "type": "boolean"},
                "plan": nullable(json!({"type": "string"})),
                "content": {"type": "string"},
                "risk_level": {"type": "string", "enum": ["low", "medium", "high"]},
                "explanation": nullable(json!({"type": "string"})),
                "memory_updates": nullable(json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "fact": {"type": "string"},
                            "scope": {"type": "string"}
                        },
                        "required": ["fact", "scope"],
                        "additionalProperties": false
                    }
                })),
                "memory_updates_message": nullable(json!({"type": "string"})),
                "watchlist_additions": nullable(json!({"type": "array", "items": {"type": "string"}}))
            },
            "required": ["type", "final", "content", "risk_level"],
            "additionalProperties": false
        })
    })
}

/// The strict-mode twin of [`command_response_json_schema`]: every property
/// required, no additional properties anywhere. Providers that honour
/// OpenAI-style strict output get this one.
pub fn wire_request_json_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| crate::llm::strict_schema(command_response_json_schema()))
}
