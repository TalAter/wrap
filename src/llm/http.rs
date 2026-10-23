//! HTTP providers: Anthropic's Messages API, OpenAI's Responses API, and
//! Chat Completions for everything OpenAI-compatible (OpenRouter, Groq,
//! Mistral, Ollama, user-defined endpoints).

use super::conversation::LlmMessage;
use super::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderResult};
use super::wires::{WireRequest, WireResponse};
use crate::config::providers::{ProviderKind, Registration};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct HttpProvider {
    name: String,
    kind: ProviderKind,
    strict: bool,
    model: String,
    api_key: Option<String>,
    key_env: Option<&'static str>,
    base_url: String,
    client: reqwest::Client,
    secrets: Vec<String>,
}

/// OpenAI strict mode requires every property in `required` and no
/// additional properties, recursively. Nullable fields already carry
/// `anyOf: [type, null]`, so the walker only adds the bookkeeping.
pub fn strict_schema(schema: &Value) -> Value {
    let mut out = schema.clone();
    add_all_required(&mut out);
    out
}

fn add_all_required(node: &mut Value) {
    let Some(map) = node.as_object_mut() else {
        return;
    };
    if map.get("type") == Some(&Value::String("object".into()))
        && let Some(props) = map.get("properties").and_then(Value::as_object)
    {
        let keys: Vec<Value> = props.keys().cloned().map(Value::String).collect();
        map.insert("required".into(), Value::Array(keys));
        map.insert("additionalProperties".into(), Value::Bool(false));
    }
    if let Some(props) = map.get_mut("properties").and_then(Value::as_object_mut) {
        for child in props.values_mut() {
            add_all_required(child);
        }
    }
    if let Some(items) = map.get_mut("items") {
        add_all_required(items);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = map.get_mut(key).and_then(Value::as_array_mut) {
            for child in branches {
                add_all_required(child);
            }
        }
    }
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value.filter(|s| !s.is_empty()).cloned()
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.join(": ")
}

// Credentials travel in headers; never follow a redirect off the origin.
fn same_origin_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let same_origin = attempt
            .previous()
            .last()
            .is_some_and(|previous| previous.origin() == attempt.url().origin());
        if attempt.previous().len() > 10 {
            attempt.error("too many redirects")
        } else if same_origin {
            attempt.follow()
        } else {
            attempt.error("redirect left the provider origin")
        }
    })
}

fn retry_delay(headers: &reqwest::header::HeaderMap, backoff: Duration) -> Duration {
    let numeric = |key: &str| {
        headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
    };
    let milliseconds = numeric("retry-after-ms")
        .or_else(|| numeric("retry-after").map(|s| s * 1000.0))
        .or_else(|| {
            headers
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| chrono::DateTime::parse_from_rfc2822(v).ok())
                .map(|date| {
                    (date.timestamp_millis() - chrono::Utc::now().timestamp_millis()) as f64
                })
        });
    milliseconds
        .filter(|n| n.is_finite() && *n >= 0.0 && (*n < 60000.0 || *n < backoff.as_millis() as f64))
        .map(|n| Duration::from_secs_f64(n / 1000.0))
        .unwrap_or(backoff)
}

fn messages_json(messages: &[LlmMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect()
}

fn extract_text(kind: ProviderKind, value: &Value) -> Option<String> {
    match kind {
        ProviderKind::Anthropic => value["content"]
            .as_array()?
            .iter()
            .filter(|item| item["type"] == "text")
            .filter_map(|item| item["text"].as_str())
            .next_back()
            .map(str::to_string),
        ProviderKind::OpenAi => value["output"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["content"].as_array())
            .flatten()
            .filter(|item| item["type"] == "output_text")
            .filter_map(|item| item["text"].as_str())
            .map(str::to_string)
            .reduce(|a, b| a + &b),
        _ => value["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string),
    }
}

fn finish_reason(value: &Value) -> Option<String> {
    value["stop_reason"]
        .as_str()
        .or_else(|| value["choices"][0]["finish_reason"].as_str())
        .or_else(|| value["status"].as_str())
        .map(str::to_string)
}

impl HttpProvider {
    pub fn new(
        name: &str,
        registration: Registration,
        model: String,
        api_key: Option<String>,
        base_url: Option<String>,
        env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let kind = registration.kind;
        let key_env = match kind {
            ProviderKind::Anthropic => Some("ANTHROPIC_API_KEY"),
            ProviderKind::OpenAi => Some("OPENAI_API_KEY"),
            ProviderKind::OpenRouter => Some("OPENROUTER_API_KEY"),
            _ => None,
        };
        let api_key = api_key.or_else(|| non_empty(key_env.and_then(|k| env.get(k))));
        let base_env = match kind {
            ProviderKind::Anthropic => env.get("ANTHROPIC_BASE_URL"),
            ProviderKind::OpenAi => env.get("OPENAI_BASE_URL"),
            _ => None,
        };
        let default_base = match kind {
            ProviderKind::Anthropic => Some("https://api.anthropic.com/v1"),
            ProviderKind::OpenAi => Some("https://api.openai.com/v1"),
            ProviderKind::OpenRouter => Some("https://openrouter.ai/api/v1"),
            _ => None,
        };
        let base_url = base_url
            .or_else(|| non_empty(base_env))
            .or_else(|| default_base.map(String::from))
            .ok_or_else(|| format!("provider \"{name}\" requires baseURL."))?;
        let client = reqwest::Client::builder()
            .redirect(same_origin_redirects())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            name: name.to_string(),
            kind,
            strict: registration.supports_structured_outputs,
            model,
            secrets: api_key.iter().cloned().collect(),
            api_key,
            key_env,
            base_url,
            client,
        })
    }

    pub fn secrets(&self) -> &[String] {
        &self.secrets
    }

    /// The request body and endpoint path for this provider kind.
    fn build_request(&self, request: &ProviderRequest<'_>) -> (&'static str, Value) {
        let messages = messages_json(request.messages);
        match self.kind {
            ProviderKind::Anthropic => (
                "messages",
                json!({
                    "model": self.model,
                    "system": request.system,
                    "messages": messages,
                    "max_tokens": 16000,
                    "output_config": {"format": {"type": "json_schema", "schema": request.schema}},
                }),
            ),
            ProviderKind::OpenAi => (
                "responses",
                json!({
                    "model": self.model,
                    "instructions": request.system,
                    "input": messages,
                    "text": {"format": {
                        "type": "json_schema",
                        "name": "wrap_response",
                        "schema": strict_schema(request.schema),
                        "strict": true,
                    }},
                }),
            ),
            kind => {
                let mut chat = vec![json!({"role": "system", "content": request.system})];
                chat.extend(messages);
                let response_format = match kind {
                    ProviderKind::OpenRouter => json!({
                        "type": "json_schema",
                        "json_schema": {"name": "wrap_response", "schema": request.schema},
                    }),
                    _ if self.strict => json!({
                        "type": "json_schema",
                        "json_schema": {
                            "name": "wrap_response",
                            "schema": strict_schema(request.schema),
                            "strict": true,
                        },
                    }),
                    _ => json!({"type": "json_object"}),
                };
                (
                    "chat/completions",
                    json!({"model": self.model, "messages": chat, "response_format": response_format}),
                )
            }
        }
    }

    pub async fn call(&self, request: ProviderRequest<'_>) -> ProviderResult {
        if self.api_key.is_none()
            && let Some(key_env) = self.key_env
        {
            return Err(ProviderError::new(format!(
                "{} API key is missing. Set apiKey in config.jsonc or the {key_env} environment variable.",
                self.name
            )));
        }
        let (path, body) = self.build_request(&request);
        // The attempt record already carries system and messages; the wire keeps
        // only the provider-specific delta.
        let wire_body: serde_json::Map<String, Value> = body
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(k, _)| {
                !matches!(k.as_str(), "system" | "messages" | "instructions" | "input")
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let request_wire = Some(WireRequest::Http {
            body: Value::Object(wire_body),
        });
        let fail = |message: String, response_wire: Option<WireResponse>| {
            Box::new(ProviderError {
                message,
                request_wire: request_wire.clone(),
                response_wire,
            })
        };

        let url = format!("{}/{path}", self.base_url.trim_end_matches('/'));
        let mut builder = self.client.post(url).json(&body);
        if self.kind == ProviderKind::Anthropic {
            builder = builder.header("anthropic-version", "2023-06-01");
            if let Some(key) = &self.api_key {
                builder = builder.header("x-api-key", key);
            }
        } else {
            builder = builder.bearer_auth(self.api_key.as_deref().unwrap_or("nokey"));
        }

        let mut attempt = 0;
        let response = loop {
            let result = builder
                .try_clone()
                .expect("JSON request is clonable")
                .send()
                .await;
            let backoff = Duration::from_millis(2000_u64 << attempt);
            match result {
                Ok(response)
                    if attempt < 2
                        && (matches!(response.status().as_u16(), 408 | 409 | 429)
                            || response.status().is_server_error()) =>
                {
                    let delay = retry_delay(response.headers(), backoff);
                    drop(response);
                    tokio::time::sleep(delay).await;
                }
                Ok(response) => break response,
                Err(error) if attempt < 2 && (error.is_connect() || error.is_timeout()) => {
                    tokio::time::sleep(backoff).await;
                }
                Err(error) => return Err(fail(error_chain(&error), None)),
            }
            attempt += 1;
        };

        let status = response.status();
        let raw = response
            .text()
            .await
            .map_err(|e| fail(error_chain(&e), None))?;
        let parsed: Option<Value> = serde_json::from_str(&raw).ok();
        if !status.is_success() {
            let detail: String = raw.chars().take(500).collect();
            let body = parsed.unwrap_or(Value::String(raw));
            return Err(fail(
                format!("Provider returned HTTP {status}: {detail}"),
                Some(WireResponse::Http {
                    body,
                    usage: None,
                    finish_reason: None,
                }),
            ));
        }
        let value = match parsed {
            Some(value) => value,
            None => {
                return Err(fail(
                    "Provider response was not valid JSON.".into(),
                    Some(WireResponse::Http {
                        body: Value::String(raw),
                        usage: None,
                        finish_reason: None,
                    }),
                ));
            }
        };
        let response_wire = Some(WireResponse::Http {
            body: value.clone(),
            usage: value.get("usage").cloned(),
            finish_reason: finish_reason(&value),
        });
        let text = extract_text(self.kind, &value).ok_or_else(|| {
            fail(
                "Model returned no structured output.".into(),
                response_wire.clone(),
            )
        })?;
        Ok(ProviderReply {
            text,
            request_wire,
            response_wire,
        })
    }
}
