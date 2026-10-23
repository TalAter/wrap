//! The seam every provider kind implements: one physical call returning the
//! model's raw text plus wire forensics, or a provider error. Parse
//! classification never happens here; it belongs to the send engine.

use super::claude_code::ClaudeCodeProvider;
use super::conversation::LlmMessage;
use super::http::HttpProvider;
use super::test_provider::TestProvider;
use super::wires::{WireRequest, WireResponse};
use serde_json::Value;

pub(crate) struct ProviderRequest<'a> {
    pub system: &'a str,
    pub messages: &'a [LlmMessage],
    pub schema: &'a Value,
}

pub(crate) struct ProviderReply {
    pub text: String,
    pub request_wire: Option<WireRequest>,
    pub response_wire: Option<WireResponse>,
}

#[derive(Debug)]
pub(crate) struct ProviderError {
    pub message: String,
    pub request_wire: Option<WireRequest>,
    pub response_wire: Option<WireResponse>,
}

/// Boxed: the wire captures make the error far larger than a reply.
pub(crate) type ProviderResult = Result<ProviderReply, Box<ProviderError>>;

impl ProviderError {
    pub fn new(message: impl Into<String>) -> Box<Self> {
        Box::new(Self {
            message: message.into(),
            request_wire: None,
            response_wire: None,
        })
    }
}

#[derive(Debug)]
pub(crate) enum Provider {
    Http(HttpProvider),
    ClaudeCode(ClaudeCodeProvider),
    Test(TestProvider),
}

impl Provider {
    pub async fn call(&self, request: ProviderRequest<'_>) -> ProviderResult {
        match self {
            Self::Http(p) => p.call(request).await,
            Self::ClaudeCode(p) => p.call(request).await,
            Self::Test(p) => p.call(request),
        }
    }

    /// Secrets that must never reach persisted entries.
    pub fn secrets(&self) -> &[String] {
        match self {
            Self::Http(p) => p.secrets(),
            Self::ClaudeCode(p) => p.secrets(),
            Self::Test(_) => &[],
        }
    }
}
