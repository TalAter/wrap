use serde_json::{Value, json};
use std::collections::HashMap;
use wrap::llm::{Llm, LlmConfig, ResolvedProvider, TestResponses, build_llm_config, strict_schema};

fn provider(
    name: &str,
    model: Option<&str>,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> ResolvedProvider {
    ResolvedProvider {
        name: name.into(),
        model: model.map(Into::into),
        api_key: api_key.map(Into::into),
        base_url: base_url.map(Into::into),
    }
}
fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
fn new(p: ResolvedProvider) -> Result<Llm, String> {
    Llm::new(LlmConfig::Provider(p), &env(&[]))
}

#[test]
fn unknown_provider_needs_base_url_api_key_and_model() {
    assert_eq!(
        new(provider("custom", Some("m"), None, None)).unwrap_err(),
        "provider \"custom\" requires baseURL, apiKey, and model."
    );
    assert_eq!(
        new(provider("custom", None, Some("k"), Some("http://x/v1"))).unwrap_err(),
        "provider \"custom\" requires baseURL, apiKey, and model."
    );
    assert!(
        new(provider(
            "custom",
            Some("m"),
            Some("sk-key-12345"),
            Some("http://x/v1")
        ))
        .is_ok()
    );
}

#[test]
fn compat_providers_need_base_url_and_api_kinds_need_a_model() {
    for name in ["ollama", "groq", "mistral"] {
        assert_eq!(
            new(provider(name, Some("llama3"), Some("k"), None)).unwrap_err(),
            format!("provider \"{name}\" requires baseURL.")
        );
    }
    assert_eq!(
        new(provider("ollama", None, None, None)).unwrap_err(),
        "provider \"ollama\" requires baseURL."
    );
    assert_eq!(
        new(provider("anthropic", None, Some("sk-x"), None)).unwrap_err(),
        "provider \"anthropic\" requires a model."
    );
    assert!(
        new(provider(
            "ollama",
            Some("llama3"),
            None,
            Some("http://localhost:11434/v1")
        ))
        .is_ok()
    );
}

#[test]
fn keyless_api_kinds_and_modelless_claude_code_stay_legal() {
    assert_eq!(
        new(provider("anthropic", Some("claude-sonnet-4-6"), None, None))
            .unwrap()
            .label(),
        "anthropic / claude-sonnet-4-6"
    );
    assert_eq!(
        new(provider("claude-code", None, None, None))
            .unwrap()
            .label(),
        "claude-code / (default)"
    );
    assert_eq!(
        new(provider("openai", Some("gpt-5"), Some("sk-x"), None))
            .unwrap()
            .label(),
        "openai / gpt-5"
    );
}

#[test]
fn env_var_api_key_indirection_resolves_from_the_env_map() {
    let unset = Llm::new(
        LlmConfig::Provider(provider(
            "anthropic",
            Some("claude-sonnet-4-6"),
            Some("$WRAP_NO_SUCH_KEY_12345"),
            None,
        )),
        &env(&[]),
    );
    assert_eq!(
        unset.unwrap_err(),
        "environment variable WRAP_NO_SUCH_KEY_12345 is not set."
    );
    let empty = Llm::new(
        LlmConfig::Provider(provider(
            "anthropic",
            Some("claude-sonnet-4-6"),
            Some("$WRAP_TEST_KEY"),
            None,
        )),
        &env(&[("WRAP_TEST_KEY", "")]),
    );
    assert_eq!(
        empty.unwrap_err(),
        "environment variable WRAP_TEST_KEY is not set."
    );
    let set = Llm::new(
        LlmConfig::Provider(provider(
            "anthropic",
            Some("claude-sonnet-4-6"),
            Some("$WRAP_TEST_KEY"),
            None,
        )),
        &env(&[("WRAP_TEST_KEY", "sk-from-env")]),
    );
    assert_eq!(set.unwrap().label(), "anthropic / claude-sonnet-4-6");
}

#[test]
fn test_kind_without_responses_is_a_config_error() {
    let err = Llm::new(LlmConfig::Test(TestResponses::List(vec![])), &env(&[])).unwrap_err();
    assert_eq!(
        err,
        "test provider has no responses configured (the name \"test\" selects canned playback)."
    );
    let ok = Llm::new(
        LlmConfig::Test(TestResponses::Single(json!("x"))),
        &env(&[]),
    )
    .unwrap();
    assert_eq!(ok.label(), "test / (default)");
}

#[test]
fn test_env_selects_canned_playback_with_responses_list_winning() {
    let resolved = provider(
        "anthropic",
        Some("claude-sonnet-4-5"),
        Some("sk-test-key"),
        None,
    );
    let list = build_llm_config(
        resolved.clone(),
        &env(&[
            ("WRAP_TEST_RESPONSES", r#"[{"facts":["macOS"]},"second"]"#),
            ("WRAP_TEST_RESPONSE", "single"),
        ]),
    )
    .unwrap();
    assert!(matches!(list, LlmConfig::Test(TestResponses::List(ref items)) if items.len() == 2));

    let single = build_llm_config(
        resolved.clone(),
        &env(&[
            ("WRAP_TEST_RESPONSES", ""),
            ("WRAP_TEST_RESPONSE", "not json {{{"),
        ]),
    )
    .unwrap();
    assert!(
        matches!(single, LlmConfig::Test(TestResponses::Single(Value::String(ref s))) if s == "not json {{{")
    );

    let broken = build_llm_config(
        resolved.clone(),
        &env(&[("WRAP_TEST_RESPONSES", "{broken")]),
    );
    assert_eq!(
        broken.unwrap_err(),
        "WRAP_TEST_RESPONSES contains invalid JSON."
    );

    let real = build_llm_config(resolved.clone(), &env(&[])).unwrap();
    assert!(matches!(real, LlmConfig::Provider(ref p) if *p == resolved));
}

#[test]
fn resolved_provider_serializes_with_config_key_names() {
    let p = provider(
        "ollama",
        Some("llama3.2"),
        None,
        Some("http://localhost:11434/v1"),
    );
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        json!({"name": "ollama", "model": "llama3.2", "baseURL": "http://localhost:11434/v1"})
    );
    let back: ResolvedProvider =
        serde_json::from_value(json!({"name": "openai", "apiKey": "sk-1", "model": "gpt-5"}))
            .unwrap();
    assert_eq!(back.api_key.as_deref(), Some("sk-1"));
}

#[test]
fn strict_schema_requires_every_property_recursively_without_mutating_the_source() {
    let source = json!({
        "type": "object",
        "properties": {
            "type": {"type": "string"},
            "note": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "nested": {"anyOf": [
                {"type": "object", "properties": {"a": {"type": "string"}, "b": {"anyOf": [{"type": "number"}, {"type": "null"}]}}, "required": ["a"]},
                {"type": "null"}
            ]},
            "list": {"type": "array", "items": {"type": "object", "properties": {"x": {"type": "string"}, "y": {"type": "string"}}, "required": ["x"]}}
        },
        "required": ["type", "list"]
    });
    let strict = strict_schema(&source);
    assert_eq!(
        strict["required"],
        json!(["type", "note", "nested", "list"])
    );
    assert_eq!(strict["additionalProperties"], false);
    assert_eq!(
        strict["properties"]["nested"]["anyOf"][0]["required"],
        json!(["a", "b"])
    );
    assert_eq!(
        strict["properties"]["nested"]["anyOf"][0]["additionalProperties"],
        false
    );
    assert_eq!(
        strict["properties"]["list"]["items"]["required"],
        json!(["x", "y"])
    );
    assert_eq!(
        strict["properties"]["note"],
        json!({"anyOf": [{"type": "string"}, {"type": "null"}]})
    );
    assert_eq!(source["required"], json!(["type", "list"]));
}
