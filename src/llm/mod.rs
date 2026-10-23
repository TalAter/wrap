//! The LLM seam: validate a provider config eagerly, hand back a label and
//! a conversation factory. Providers, wire capture, secret scrubbing, and
//! the send engine stay behind it.

mod claude_code;
mod conversation;
mod errors;
mod http;
mod provider;
mod test_provider;
mod wires;

pub use claude_code::{build_argv, flatten_messages};
pub use conversation::{
    Attempt, AttemptError, AttemptErrorKind, AttemptRequest, Conversation, ConversationOptions,
    EchoPredicate, Entry, LlmMessage, Role, SendOptions, replayable,
};
pub use errors::{LlmError, ParseReason};
pub use http::strict_schema;
pub use wires::{WireRequest, WireResponse, scrub_secrets, scrub_text};

use provider::Provider;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub use crate::config::ResolvedProvider;

/// Canned playback data: a single response repeats; a list plays one entry
/// per physical call. Strings play verbatim, objects are stringified, and
/// an `ERROR:`-prefixed string fails the call.
#[derive(Clone, Debug, PartialEq)]
pub enum TestResponses {
    Single(Value),
    List(Vec<Value>),
}

#[derive(Debug)]
pub enum LlmConfig {
    Provider(ResolvedProvider),
    Test(TestResponses),
}

/// Build the config from the test-provider env contract or the resolved
/// provider. A non-empty `WRAP_TEST_RESPONSES` (JSON) wins; otherwise a set
/// `WRAP_TEST_RESPONSE` is a single verbatim response.
pub fn build_llm_config(
    resolved: ResolvedProvider,
    env: &HashMap<String, String>,
) -> Result<LlmConfig, String> {
    if let Some(json) = env.get("WRAP_TEST_RESPONSES").filter(|s| !s.is_empty()) {
        let value: Value = serde_json::from_str(json)
            .map_err(|_| "WRAP_TEST_RESPONSES contains invalid JSON.".to_string())?;
        return Ok(LlmConfig::Test(match value {
            Value::Array(items) => TestResponses::List(items),
            other => TestResponses::Single(other),
        }));
    }
    if let Some(single) = env.get("WRAP_TEST_RESPONSE") {
        return Ok(LlmConfig::Test(TestResponses::Single(Value::String(
            single.clone(),
        ))));
    }
    Ok(LlmConfig::Provider(resolved))
}

/// [`build_llm_config`] followed by [`Llm::new`].
pub fn init_llm(resolved: ResolvedProvider, env: &HashMap<String, String>) -> Result<Llm, String> {
    Llm::new(build_llm_config(resolved, env)?, env)
}

/// Dereference a `$ENV_VAR` api key. A missing variable is a config error
/// at creation, never a transport failure mid-conversation.
fn resolve_api_key(
    value: Option<String>,
    env: &HashMap<String, String>,
) -> Result<Option<String>, String> {
    match value {
        Some(key) if key.starts_with('$') => {
            let name = &key[1..];
            env.get(name)
                .filter(|v| !v.is_empty())
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("environment variable {name} is not set."))
        }
        other => Ok(other),
    }
}

/// A provider handle: eager validation now, conversations on demand.
/// Cloning shares the provider, so the test playback cursor is shared too.
#[derive(Clone, Debug)]
pub struct Llm {
    label: String,
    provider: Arc<Provider>,
}

impl Llm {
    pub fn new(config: LlmConfig, env: &HashMap<String, String>) -> Result<Llm, String> {
        match config {
            LlmConfig::Test(responses) => {
                if matches!(&responses, TestResponses::List(items) if items.is_empty()) {
                    return Err(
                        "test provider has no responses configured (the name \"test\" selects canned playback)."
                            .into(),
                    );
                }
                Ok(Llm {
                    label: "test / (default)".into(),
                    provider: Arc::new(Provider::Test(test_provider::TestProvider::new(responses))),
                })
            }
            LlmConfig::Provider(entry) => {
                if let Some(error) = crate::config::providers::validate_provider_entry(
                    &entry.name,
                    &crate::config::ProviderEntry {
                        api_key: entry.api_key.clone(),
                        base_url: entry.base_url.clone(),
                        model: entry.model.clone(),
                    },
                ) {
                    return Err(error);
                }
                let registration = crate::config::providers::registration(&entry.name);
                if entry.model.is_none() && !registration.model_optional {
                    return Err(format!("provider \"{}\" requires a model.", entry.name));
                }
                let api_key = resolve_api_key(entry.api_key, env)?;
                let label = format!(
                    "{} / {}",
                    entry.name,
                    entry.model.as_deref().unwrap_or("(default)")
                );
                let provider = match registration.kind {
                    crate::config::providers::ProviderKind::ClaudeCode => Provider::ClaudeCode(
                        claude_code::ClaudeCodeProvider::new(entry.model, api_key, env),
                    ),
                    _ => Provider::Http(http::HttpProvider::new(
                        &entry.name,
                        registration,
                        entry.model.unwrap_or_default(),
                        api_key,
                        entry.base_url,
                        env,
                    )?),
                };
                Ok(Llm {
                    label,
                    provider: Arc::new(provider),
                })
            }
        }
    }

    /// "name / model" for verbose lines and UI.
    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn start_conversation(&self, options: ConversationOptions) -> Conversation {
        Conversation::new(self.provider.clone(), options)
    }
}
