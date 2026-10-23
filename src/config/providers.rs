//! Provider registry: which built-in provider names exist, how each is
//! handled at runtime, and the metadata the wizard shows for them.

use super::ProviderEntry;

/// Runtime SDK family. One kind = one wire implementation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    Anthropic,
    OpenAi,
    OpenRouter,
    /// Chat Completions against any OpenAI-compatible endpoint (groq, mistral,
    /// ollama, and every unknown user-defined provider).
    OpenAiCompat,
    ClaudeCode,
}

pub struct ApiProvider {
    pub name: &'static str,
    pub display_name: &'static str,
    pub kind: ProviderKind,
    /// Honors OpenAI-style strict `json_schema` response format.
    pub supports_structured_outputs: bool,
    /// Where the user gets an API key. Shown on the wizard's API-key screen;
    /// also decides whether that screen appears at all.
    pub api_key_url: Option<&'static str>,
    pub api_key_placeholder: Option<&'static str>,
    /// Fallback baseURL when models.dev has no `api` field for this provider.
    /// The wizard writes it into the config entry verbatim.
    pub base_url: Option<&'static str>,
    /// Regex source matching the recommended (latest flagship) model names.
    pub recommended_model_regex: Option<&'static str>,
    /// Nerd Font glyph shown in the wizard when nerdFonts is enabled.
    pub nerd_icon: Option<&'static str>,
    /// Entries must carry an explicit baseURL (non-default endpoint).
    pub requires_base_url: bool,
}

pub struct CliProvider {
    pub name: &'static str,
    pub display_name: &'static str,
    /// Binary name the wizard looks up on PATH to detect the provider.
    pub probe_cmd: &'static str,
    pub nerd_icon: Option<&'static str>,
}

/// Declaration order doubles as the wizard's provider-selection order.
pub static API_PROVIDERS: &[ApiProvider] = &[
    ApiProvider {
        name: "anthropic",
        display_name: "Anthropic",
        kind: ProviderKind::Anthropic,
        supports_structured_outputs: false,
        api_key_url: Some("https://console.anthropic.com/settings/keys"),
        api_key_placeholder: Some("sk-ant-api03-"),
        base_url: None,
        recommended_model_regex: Some(r"^claude-sonnet(-\d+)+$"),
        nerd_icon: Some("\u{e754}"),
        requires_base_url: false,
    },
    ApiProvider {
        name: "openai",
        display_name: "OpenAI",
        kind: ProviderKind::OpenAi,
        supports_structured_outputs: true,
        api_key_url: Some("https://platform.openai.com/api-keys"),
        api_key_placeholder: Some("sk-proj-"),
        base_url: None,
        recommended_model_regex: Some(r"^gpt-5(\.\d+)?$"),
        nerd_icon: Some("\u{f0104}"),
        requires_base_url: false,
    },
    ApiProvider {
        name: "openrouter",
        display_name: "OpenRouter",
        kind: ProviderKind::OpenRouter,
        supports_structured_outputs: false,
        api_key_url: Some("https://openrouter.ai/keys"),
        api_key_placeholder: Some("sk-or-v1-"),
        base_url: Some("https://openrouter.ai/api/v1"),
        recommended_model_regex: None,
        nerd_icon: Some("\u{ea63}"),
        requires_base_url: false,
    },
    ApiProvider {
        name: "groq",
        display_name: "Groq",
        kind: ProviderKind::OpenAiCompat,
        supports_structured_outputs: true,
        api_key_url: Some("https://console.groq.com/keys"),
        api_key_placeholder: Some("gsk_"),
        base_url: None,
        recommended_model_regex: None,
        nerd_icon: Some("\u{f140b}"),
        requires_base_url: true,
    },
    ApiProvider {
        name: "mistral",
        display_name: "Mistral",
        kind: ProviderKind::OpenAiCompat,
        supports_structured_outputs: true,
        api_key_url: Some("https://console.mistral.ai/api-keys"),
        api_key_placeholder: None,
        base_url: None,
        recommended_model_regex: None,
        nerd_icon: Some("\u{ef16}"),
        requires_base_url: true,
    },
    ApiProvider {
        name: "ollama",
        display_name: "Ollama (local)",
        kind: ProviderKind::OpenAiCompat,
        supports_structured_outputs: true,
        api_key_url: None,
        api_key_placeholder: None,
        base_url: Some("http://localhost:11434/v1"),
        recommended_model_regex: None,
        nerd_icon: Some("\u{f019a}"),
        requires_base_url: true,
    },
];

pub static CLI_PROVIDERS: &[CliProvider] = &[CliProvider {
    name: "claude-code",
    display_name: "Claude Code",
    probe_cmd: "claude",
    nerd_icon: Some("\u{f0bc9}"),
}];

/// How the runtime treats a provider name. Unknown names are user-defined
/// OpenAI-compatible endpoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Registration {
    pub kind: ProviderKind,
    /// Entries may omit `model`; the underlying binary picks its own default.
    pub model_optional: bool,
    pub supports_structured_outputs: bool,
}

pub fn api_provider(name: &str) -> Option<&'static ApiProvider> {
    API_PROVIDERS.iter().find(|p| p.name == name)
}

pub fn cli_provider(name: &str) -> Option<&'static CliProvider> {
    CLI_PROVIDERS.iter().find(|p| p.name == name)
}

pub fn is_known_provider(name: &str) -> bool {
    api_provider(name).is_some() || cli_provider(name).is_some()
}

pub fn is_cli_provider(name: &str) -> bool {
    cli_provider(name).is_some()
}

/// Whether the wizard shows an API-key screen: only API providers that
/// publish a key URL (ollama has no key, claude-code is CLI-backed).
pub fn provider_needs_api_key(name: &str) -> bool {
    api_provider(name).is_some_and(|p| p.api_key_url.is_some())
}

pub fn registration(name: &str) -> Registration {
    if let Some(p) = api_provider(name) {
        return Registration {
            kind: p.kind,
            model_optional: false,
            supports_structured_outputs: p.supports_structured_outputs,
        };
    }
    if cli_provider(name).is_some() {
        return Registration {
            kind: ProviderKind::ClaudeCode,
            model_optional: true,
            supports_structured_outputs: false,
        };
    }
    Registration {
        kind: ProviderKind::OpenAiCompat,
        model_optional: false,
        supports_structured_outputs: false,
    }
}

/// Structural check of one entry. Known providers only need a baseURL when
/// their endpoint is non-default; unknown providers must supply baseURL,
/// apiKey, and model so a placeholder key is never sent to a billed endpoint.
/// Messages are bare plain language; the caller adds its category prefix.
pub fn validate_provider_entry(name: &str, entry: &ProviderEntry) -> Option<String> {
    if let Some(p) = api_provider(name) {
        if p.requires_base_url && entry.base_url.as_deref().is_none_or(str::is_empty) {
            return Some(format!("provider \"{name}\" requires baseURL."));
        }
        return None;
    }
    if cli_provider(name).is_some() {
        return None;
    }
    let present = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
    if !present(&entry.base_url) || !present(&entry.api_key) || !present(&entry.model) {
        return Some(format!(
            "provider \"{name}\" requires baseURL, apiKey, and model."
        ));
    }
    None
}
