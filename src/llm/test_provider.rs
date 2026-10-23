//! Canned playback. A single response repeats indefinitely; a list plays
//! one entry per physical call and then exhausts. An `ERROR:`-prefixed
//! string fails the call as a provider error.

use super::TestResponses;
use super::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderResult};
use super::wires::{WireRequest, WireResponse};
use serde_json::Value;
use std::sync::Mutex;

#[derive(Debug)]
pub(crate) struct TestProvider {
    responses: TestResponses,
    cursor: Mutex<usize>,
}

fn stringify(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl TestProvider {
    pub fn new(responses: TestResponses) -> Self {
        Self {
            responses,
            cursor: Mutex::new(0),
        }
    }

    fn next(&self) -> Result<String, String> {
        match &self.responses {
            TestResponses::Single(value) => Ok(stringify(value)),
            TestResponses::List(items) => {
                let mut cursor = self.cursor.lock().unwrap_or_else(|e| e.into_inner());
                let index = *cursor;
                *cursor += 1;
                items.get(index).map(stringify).ok_or_else(|| {
                    format!(
                        "No test response left for call {} ({} provided).",
                        index + 1,
                        items.len()
                    )
                })
            }
        }
    }

    pub fn call(&self, _request: ProviderRequest<'_>) -> ProviderResult {
        let raw = self.next().map_err(|message| {
            Box::new(ProviderError {
                message,
                request_wire: Some(WireRequest::Test),
                response_wire: None,
            })
        })?;
        if let Some(rest) = raw.strip_prefix("ERROR:") {
            return Err(Box::new(ProviderError {
                message: rest.trim_start().to_string(),
                request_wire: Some(WireRequest::Test),
                response_wire: Some(WireResponse::Test),
            }));
        }
        Ok(ProviderReply {
            text: raw,
            request_wire: Some(WireRequest::Test),
            response_wire: Some(WireResponse::Test),
        })
    }
}
