//! Wire-level forensics for one physical model call. Bodies only, never
//! headers: the authorization header is never captured, so a key that
//! arrived through an environment fallback cannot leak into persisted
//! entries even before scrubbing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WireRequest {
    Http { body: Value },
    Subprocess { argv: Vec<String>, stdin: String },
    Test,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WireResponse {
    Http {
        body: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
        #[serde(
            rename = "finishReason",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        finish_reason: Option<String>,
    },
    Subprocess {
        stdout: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stderr: Option<String>,
        exit_code: i32,
    },
    Test,
}

impl WireRequest {
    pub(crate) fn scrubbed(self, secrets: &[String]) -> Self {
        match self {
            Self::Http { body } => Self::Http {
                body: scrub_secrets(&body, secrets),
            },
            Self::Subprocess { argv, stdin } => Self::Subprocess {
                argv: argv.iter().map(|a| scrub_text(a, secrets)).collect(),
                stdin: scrub_text(&stdin, secrets),
            },
            Self::Test => Self::Test,
        }
    }
}

impl WireResponse {
    pub(crate) fn scrubbed(self, secrets: &[String]) -> Self {
        match self {
            Self::Http {
                body,
                usage,
                finish_reason,
            } => Self::Http {
                body: scrub_secrets(&body, secrets),
                usage,
                finish_reason,
            },
            Self::Subprocess {
                stdout,
                stderr,
                exit_code,
            } => Self::Subprocess {
                stdout: scrub_text(&stdout, secrets),
                stderr: stderr.map(|s| scrub_text(&s, secrets)),
                exit_code,
            },
            Self::Test => Self::Test,
        }
    }
}

fn usable(secrets: &[String]) -> impl Iterator<Item = &String> {
    secrets.iter().filter(|s| s.len() >= 8)
}

/// Replace every occurrence of each secret with its redacted suffix form
/// (`...last4`). Secrets shorter than 8 characters are ignored: substring
/// matching on short values would redact ordinary text.
pub fn scrub_text(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in usable(secrets) {
        if out.contains(secret.as_str()) {
            let count = secret.chars().count();
            let suffix: String = secret.chars().skip(count.saturating_sub(4)).collect();
            out = out.replace(secret.as_str(), &format!("...{suffix}"));
        }
    }
    out
}

/// [`scrub_text`] applied to every string inside a JSON value.
pub fn scrub_secrets(value: &Value, secrets: &[String]) -> Value {
    if usable(secrets).next().is_none() {
        return value.clone();
    }
    match value {
        Value::String(s) => Value::String(scrub_text(s, secrets)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| scrub_secrets(v, secrets)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), scrub_secrets(v, secrets)))
                .collect(),
        ),
        other => other.clone(),
    }
}
