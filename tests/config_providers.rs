use regex::Regex;
use wrap::config::ProviderEntry;
use wrap::config::providers::{
    API_PROVIDERS, CLI_PROVIDERS, ProviderKind, is_cli_provider, is_known_provider,
    provider_needs_api_key, registration, validate_provider_entry,
};

fn entry(api_key: Option<&str>, base_url: Option<&str>, model: Option<&str>) -> ProviderEntry {
    ProviderEntry {
        api_key: api_key.map(str::to_string),
        base_url: base_url.map(str::to_string),
        model: model.map(str::to_string),
    }
}

#[test]
fn api_provider_order_is_the_wizard_display_order() {
    let names: Vec<&str> = API_PROVIDERS.iter().map(|p| p.name).collect();
    assert_eq!(
        names,
        [
            "anthropic",
            "openai",
            "openrouter",
            "groq",
            "mistral",
            "ollama"
        ]
    );
}

#[test]
fn api_providers_carry_wizard_metadata() {
    for p in API_PROVIDERS {
        assert!(!p.display_name.is_empty(), "{}", p.name);
        if p.name != "ollama" {
            assert!(p.api_key_url.is_some(), "{} needs an apiKeyUrl", p.name);
        }
    }
    assert_eq!(
        API_PROVIDERS
            .iter()
            .find(|p| p.name == "ollama")
            .unwrap()
            .base_url,
        Some("http://localhost:11434/v1")
    );
}

#[test]
fn claude_code_is_the_only_cli_provider_and_probes_claude() {
    assert_eq!(CLI_PROVIDERS.len(), 1);
    assert_eq!(CLI_PROVIDERS[0].name, "claude-code");
    assert_eq!(CLI_PROVIDERS[0].probe_cmd, "claude");
}

#[test]
fn recommended_model_regexes_match_flagships_only() {
    let regex_for = |name: &str| {
        Regex::new(
            API_PROVIDERS
                .iter()
                .find(|p| p.name == name)
                .unwrap()
                .recommended_model_regex
                .unwrap(),
        )
        .unwrap()
    };
    let anthropic = regex_for("anthropic");
    assert!(anthropic.is_match("claude-sonnet-4-6"));
    assert!(anthropic.is_match("claude-sonnet-5"));
    assert!(!anthropic.is_match("claude-haiku-4-5"));
    let openai = regex_for("openai");
    assert!(openai.is_match("gpt-5"));
    assert!(openai.is_match("gpt-5.1"));
    assert!(!openai.is_match("gpt-4"));
}

#[test]
fn known_and_cli_provider_lookups() {
    for name in ["anthropic", "ollama", "openrouter", "claude-code"] {
        assert!(is_known_provider(name), "{name}");
    }
    assert!(!is_known_provider("custom"));
    assert!(!is_known_provider(""));
    assert!(is_cli_provider("claude-code"));
    assert!(!is_cli_provider("anthropic"));
    assert!(!is_cli_provider("custom"));
}

#[test]
fn provider_needs_api_key_only_for_api_providers_with_a_key_url() {
    for name in ["anthropic", "openai", "openrouter"] {
        assert!(provider_needs_api_key(name), "{name}");
    }
    for name in ["ollama", "claude-code", "custom"] {
        assert!(!provider_needs_api_key(name), "{name}");
    }
}

#[test]
fn registration_kinds_and_structured_output_support() {
    assert_eq!(registration("anthropic").kind, ProviderKind::Anthropic);
    assert_eq!(registration("openai").kind, ProviderKind::OpenAi);
    assert_eq!(registration("openrouter").kind, ProviderKind::OpenRouter);
    assert_eq!(registration("ollama").kind, ProviderKind::OpenAiCompat);
    assert_eq!(registration("claude-code").kind, ProviderKind::ClaudeCode);
    assert_eq!(registration("somebody").kind, ProviderKind::OpenAiCompat);
    for name in ["openai", "groq", "mistral", "ollama"] {
        assert!(registration(name).supports_structured_outputs, "{name}");
    }
    assert!(!registration("somebody").supports_structured_outputs);
    assert!(!registration("anthropic").supports_structured_outputs);
    assert!(registration("claude-code").model_optional);
    assert!(!registration("anthropic").model_optional);
}

#[test]
fn validate_provider_entry_messages_are_bare() {
    assert_eq!(
        validate_provider_entry("groq", &entry(Some("x"), None, Some("y"))),
        Some("provider \"groq\" requires baseURL.".to_string())
    );
    assert_eq!(
        validate_provider_entry("custom", &entry(None, None, Some("x"))),
        Some("provider \"custom\" requires baseURL, apiKey, and model.".to_string())
    );
    for name in ["mistral", "ollama"] {
        assert!(
            validate_provider_entry(name, &entry(None, None, Some("m")))
                .unwrap()
                .contains("requires baseURL"),
            "{name}"
        );
    }
}

#[test]
fn validate_provider_entry_accepts_valid_shapes() {
    assert_eq!(
        validate_provider_entry("openrouter", &entry(Some("x"), None, Some("y"))),
        None
    );
    assert_eq!(
        validate_provider_entry("anthropic", &entry(None, None, Some("claude-sonnet-4-6"))),
        None
    );
    assert_eq!(
        validate_provider_entry("openai", &entry(Some("sk"), None, Some("gpt-5"))),
        None
    );
    assert_eq!(
        validate_provider_entry("claude-code", &entry(None, None, None)),
        None
    );
    assert_eq!(
        validate_provider_entry(
            "custom",
            &entry(Some("x"), Some("https://api.example.com/v1"), Some("y"))
        ),
        None
    );
}
