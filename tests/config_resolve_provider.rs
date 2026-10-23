use std::collections::{BTreeMap, HashMap};
use wrap::cli::Modifiers;
use wrap::config::{
    Config, ModelOverride, ProviderEntry, ResolvedConfig, ResolvedProvider, parse_model_override,
    resolve_provider, resolve_settings,
};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn entry(api_key: Option<&str>, base_url: Option<&str>, model: Option<&str>) -> ProviderEntry {
    ProviderEntry {
        api_key: api_key.map(str::to_string),
        base_url: base_url.map(str::to_string),
        model: model.map(str::to_string),
    }
}

fn providers(list: &[(&str, ProviderEntry)]) -> BTreeMap<String, ProviderEntry> {
    list.iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

fn config(providers: BTreeMap<String, ProviderEntry>, default: Option<&str>) -> ResolvedConfig {
    ResolvedConfig {
        providers,
        default_provider: default.map(str::to_string),
        ..resolve_settings(&Modifiers::default(), &env(&[]), &Config::default()).unwrap()
    }
}

fn resolved(
    name: &str,
    model: Option<&str>,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> ResolvedProvider {
    ResolvedProvider {
        name: name.into(),
        model: model.map(str::to_string),
        api_key: api_key.map(str::to_string),
        base_url: base_url.map(str::to_string),
    }
}

#[test]
fn test_env_vars_select_the_test_sentinel_regardless_of_config() {
    let real = config(
        providers(&[("anthropic", entry(Some("k"), None, Some("claude")))]),
        Some("anthropic"),
    );
    for e in [
        env(&[("WRAP_TEST_RESPONSE", "{}")]),
        env(&[("WRAP_TEST_RESPONSE", "")]),
        env(&[("WRAP_TEST_RESPONSES", "[]")]),
    ] {
        assert_eq!(
            resolve_provider(&real, &e).unwrap(),
            resolved("test", None, None, None)
        );
        assert_eq!(
            resolve_provider(&config(BTreeMap::new(), None), &e).unwrap(),
            resolved("test", None, None, None)
        );
    }
}

#[test]
fn default_provider_resolves_to_its_entry() {
    let c = config(
        providers(&[(
            "anthropic",
            entry(Some("sk-x"), None, Some("claude-haiku-4-5")),
        )]),
        Some("anthropic"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap(),
        resolved("anthropic", Some("claude-haiku-4-5"), Some("sk-x"), None)
    );
    let c = config(
        providers(&[(
            "ollama",
            entry(None, Some("http://localhost:11434/v1"), Some("llama3.2")),
        )]),
        Some("ollama"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap(),
        resolved(
            "ollama",
            Some("llama3.2"),
            None,
            Some("http://localhost:11434/v1")
        )
    );
}

#[test]
fn missing_default_provider_is_the_generic_no_llm_error() {
    const NO_LLM: &str = "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.";
    assert_eq!(
        resolve_provider(&config(BTreeMap::new(), None), &env(&[])).unwrap_err(),
        NO_LLM
    );
    assert_eq!(
        resolve_provider(&config(BTreeMap::new(), Some("")), &env(&[])).unwrap_err(),
        NO_LLM
    );
    let c = config(
        providers(&[("anthropic", entry(Some("k"), None, Some("m")))]),
        None,
    );
    assert_eq!(resolve_provider(&c, &env(&[])).unwrap_err(), NO_LLM);
}

#[test]
fn default_provider_without_an_entry_is_a_not_found_error() {
    assert_eq!(
        resolve_provider(&config(BTreeMap::new(), Some("anthropic")), &env(&[])).unwrap_err(),
        "Config error: provider \"anthropic\" not found in config."
    );
    let c = config(
        providers(&[("anthropic", entry(Some("k"), None, Some("m")))]),
        Some("openai"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap_err(),
        "Config error: provider \"openai\" not found in config."
    );
}

#[test]
fn api_providers_need_a_model_but_claude_code_does_not() {
    let c = config(
        providers(&[("anthropic", entry(Some("k"), None, None))]),
        Some("anthropic"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap_err(),
        "Config error: provider \"anthropic\" has no model set in config."
    );
    let c = config(
        providers(&[("claude-code", entry(None, None, Some("sonnet")))]),
        Some("claude-code"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap(),
        resolved("claude-code", Some("sonnet"), None, None)
    );
    let c = config(
        providers(&[("claude-code", entry(None, None, None))]),
        Some("claude-code"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap(),
        resolved("claude-code", None, None, None)
    );
}

#[test]
fn entry_validation_runs_before_the_model_check() {
    let c = config(
        providers(&[("ollama", entry(None, None, Some("llama3.2")))]),
        Some("ollama"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap_err(),
        "Config error: provider \"ollama\" requires baseURL."
    );
    let c = config(
        providers(&[("ollama", entry(None, None, None))]),
        Some("ollama"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap_err(),
        "Config error: provider \"ollama\" requires baseURL."
    );
    for e in [
        entry(
            None,
            Some("https://api.custom.com/openai/v1"),
            Some("llama"),
        ),
        entry(Some("gsk_x"), None, Some("llama")),
        entry(None, Some("https://api.custom.com/openai/v1"), None),
    ] {
        let c = config(providers(&[("custom", e)]), Some("custom"));
        assert_eq!(
            resolve_provider(&c, &env(&[])).unwrap_err(),
            "Config error: provider \"custom\" requires baseURL, apiKey, and model."
        );
    }
}

#[test]
fn complete_unknown_provider_and_keyless_anthropic_are_valid() {
    let c = config(
        providers(&[(
            "custom",
            entry(
                Some("gsk_x"),
                Some("https://api.custom.com/openai/v1"),
                Some("llama-3.1-70b-versatile"),
            ),
        )]),
        Some("custom"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap(),
        resolved(
            "custom",
            Some("llama-3.1-70b-versatile"),
            Some("gsk_x"),
            Some("https://api.custom.com/openai/v1")
        )
    );
    let c = config(
        providers(&[("anthropic", entry(None, None, Some("claude-haiku-4-5")))]),
        Some("anthropic"),
    );
    assert_eq!(
        resolve_provider(&c, &env(&[])).unwrap(),
        resolved("anthropic", Some("claude-haiku-4-5"), None, None)
    );
}

#[test]
fn resolved_provider_serializes_with_camel_case_keys_and_omits_absent_fields() {
    let json = serde_json::to_value(resolved("ollama", Some("m"), None, Some("http://x"))).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"name": "ollama", "model": "m", "baseURL": "http://x"})
    );
    let back: ResolvedProvider =
        serde_json::from_value(serde_json::json!({"name": "a", "apiKey": "k"})).unwrap();
    assert_eq!(back, resolved("a", None, Some("k"), None));
}

fn two_providers() -> BTreeMap<String, ProviderEntry> {
    providers(&[
        (
            "anthropic",
            entry(Some("sk-a"), None, Some("claude-haiku-4-5")),
        ),
        ("openai", entry(Some("sk-o"), None, Some("gpt-4o-mini"))),
    ])
}

fn over(provider: Option<&str>, model: Option<&str>) -> ModelOverride {
    ModelOverride {
        provider_name: provider.map(str::to_string),
        transient_model: model.map(str::to_string),
    }
}

#[test]
fn colon_forms_split_on_the_first_colon() {
    let p = two_providers();
    assert_eq!(
        parse_model_override("anthropic:claude-opus-4-5", &p, Some("anthropic")).unwrap(),
        over(Some("anthropic"), Some("claude-opus-4-5"))
    );
    assert_eq!(
        parse_model_override("openai:gpt-4o:turbo", &p, Some("anthropic")).unwrap(),
        over(Some("openai"), Some("gpt-4o:turbo"))
    );
    assert_eq!(
        parse_model_override(":claude-opus-4-5", &p, Some("anthropic")).unwrap(),
        over(Some("anthropic"), Some("claude-opus-4-5"))
    );
    assert_eq!(
        parse_model_override("openai:", &p, Some("anthropic")).unwrap(),
        over(Some("openai"), None)
    );
    assert_eq!(
        parse_model_override(":x", &p, None).unwrap(),
        over(None, Some("x"))
    );
}

#[test]
fn empty_overrides_are_errors() {
    let p = two_providers();
    for raw in ["", "   ", ":"] {
        assert_eq!(
            parse_model_override(raw, &p, Some("anthropic")).unwrap_err(),
            "Config error: --model value is empty.",
            "{raw:?}"
        );
    }
}

#[test]
fn bare_values_resolve_by_provider_key_then_unique_model_then_fall_through() {
    let p = two_providers();
    assert_eq!(
        parse_model_override("openai", &p, Some("anthropic")).unwrap(),
        over(Some("openai"), None)
    );
    assert_eq!(
        parse_model_override("anthropic", &p, Some("anthropic")).unwrap(),
        over(Some("anthropic"), None)
    );
    assert_eq!(
        parse_model_override("gpt-4o-mini", &p, Some("anthropic")).unwrap(),
        over(Some("openai"), None)
    );
    assert_eq!(
        parse_model_override("gpt-9999", &p, Some("anthropic")).unwrap(),
        over(Some("anthropic"), Some("gpt-9999"))
    );
}

#[test]
fn ambiguous_models_and_unconfigured_builtins_are_errors() {
    let dup = providers(&[
        ("anthropic", entry(Some("k"), None, Some("shared-model"))),
        ("openai", entry(Some("k"), None, Some("shared-model"))),
    ]);
    assert_eq!(
        parse_model_override("shared-model", &dup, Some("anthropic")).unwrap_err(),
        "Config error: model \"shared-model\" is configured for multiple providers; use provider:model."
    );
    let only_anthropic = providers(&[("anthropic", entry(Some("k"), None, Some("m")))]);
    for name in ["openai", "ollama"] {
        assert_eq!(
            parse_model_override(name, &only_anthropic, Some("anthropic")).unwrap_err(),
            format!("Config error: provider \"{name}\" not found in config.")
        );
    }
}
