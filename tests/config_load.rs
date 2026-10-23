use std::collections::HashMap;
use wrap::config::{AppearanceSetting, Config, ProviderEntry, load_config};
use wrap::home::WrapHome;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn home_with(contents: Option<&str>) -> (tempfile::TempDir, WrapHome) {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    if let Some(c) = contents {
        home.write("config.jsonc", c).unwrap();
    }
    (dir, home)
}

fn model(m: &str) -> ProviderEntry {
    ProviderEntry {
        model: Some(m.to_string()),
        ..ProviderEntry::default()
    }
}

#[test]
fn absent_file_and_no_override_is_the_default_config() {
    let (_d, home) = home_with(None);
    assert_eq!(load_config(&home, &env(&[])).unwrap(), Config::default());
}

#[test]
fn empty_file_is_the_default_config() {
    let (_d, home) = home_with(Some(""));
    assert_eq!(load_config(&home, &env(&[])).unwrap(), Config::default());
}

#[test]
fn whitespace_only_override_is_treated_as_unset() {
    let (_d, home) = home_with(None);
    assert_eq!(
        load_config(&home, &env(&[("WRAP_CONFIG", "  ")])).unwrap(),
        Config::default()
    );
}

#[test]
fn reads_providers_and_settings_from_the_override() {
    let (_d, home) = home_with(None);
    let config = load_config(
        &home,
        &env(&[(
            "WRAP_CONFIG",
            r#"{"providers":{"claude-code":{"model":"opus"}},"defaultProvider":"claude-code","maxRounds":7,"maxCapturedOutputChars":100000,"maxAttachedInputChars":100000}"#,
        )]),
    )
    .unwrap();
    assert_eq!(config.providers.unwrap()["claude-code"], model("opus"));
    assert_eq!(config.default_provider.as_deref(), Some("claude-code"));
    assert_eq!(config.max_rounds, Some(7));
    assert_eq!(config.max_captured_output_chars, Some(100_000));
    assert_eq!(config.max_attached_input_chars, Some(100_000));
}

#[test]
fn unset_fields_stay_none() {
    let (_d, home) = home_with(None);
    let config = load_config(&home, &env(&[("WRAP_CONFIG", "{}")])).unwrap();
    assert_eq!(config.max_rounds, None);
    assert_eq!(config.max_captured_output_chars, None);
    assert_eq!(config.max_attached_input_chars, None);
    assert_eq!(config.default_provider, None);
}

#[test]
fn malformed_override_names_the_variable() {
    let (_d, home) = home_with(None);
    assert_eq!(
        load_config(&home, &env(&[("WRAP_CONFIG", "{broken")])).unwrap_err(),
        "WRAP_CONFIG contains invalid JSON."
    );
}

#[test]
fn reads_jsonc_with_comments_trailing_commas_and_schema_key() {
    let (_d, home) = home_with(Some(
        r#"{
  "$schema": "./config.schema.json",
  // LLM provider
  "providers": { "anthropic": { "apiKey": "$KEY", "model": "claude-haiku-4-5", }, },
  "defaultProvider": "anthropic",
  "maxRounds": 3,
  "appearance": "light",
}"#,
    ));
    let config = load_config(&home, &env(&[])).unwrap();
    assert_eq!(
        config.providers.as_ref().unwrap()["anthropic"],
        ProviderEntry {
            api_key: Some("$KEY".into()),
            base_url: None,
            model: Some("claude-haiku-4-5".into()),
        }
    );
    assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(config.max_rounds, Some(3));
    assert_eq!(config.appearance, Some(AppearanceSetting::Light));
    assert_eq!(
        config.extra.get("$schema").and_then(|v| v.as_str()),
        Some("./config.schema.json")
    );
}

#[test]
fn unknown_top_level_keys_are_preserved() {
    let (_d, home) = home_with(Some(r#"{"future": true}"#));
    let config = load_config(&home, &env(&[])).unwrap();
    assert_eq!(
        config.extra.get("future"),
        Some(&serde_json::Value::Bool(true))
    );
}

#[test]
fn malformed_file_names_the_file_without_exposing_content() {
    let (_d, home) = home_with(Some("{ broken json secret"));
    assert_eq!(
        load_config(&home, &env(&[])).unwrap_err(),
        "config.jsonc contains invalid JSON."
    );
}

#[test]
fn json5_extensions_and_missing_commas_are_rejected() {
    for raw in [
        r#"{key:"value"}"#,
        r#"{"key":'value'}"#,
        r#"{"a":1 "b":2}"#,
        r#"{"a":0xff}"#,
    ] {
        let (_d, home) = home_with(Some(raw));
        assert!(load_config(&home, &env(&[])).is_err(), "accepted {raw}");
    }
}

#[test]
fn wrong_value_types_name_the_offending_setting() {
    let (_d, home) = home_with(Some(r#"{"maxRounds": "five"}"#));
    assert_eq!(
        load_config(&home, &env(&[])).unwrap_err(),
        "config.jsonc has an invalid value for \"maxRounds\"."
    );
    let (_d, home) = home_with(None);
    assert_eq!(
        load_config(&home, &env(&[("WRAP_CONFIG", r#"{"verbose": "yes"}"#)])).unwrap_err(),
        "WRAP_CONFIG has an invalid value for \"verbose\"."
    );
}

#[test]
fn non_object_file_is_rejected() {
    let (_d, home) = home_with(Some("[1, 2]"));
    assert_eq!(
        load_config(&home, &env(&[])).unwrap_err(),
        "config.jsonc must contain a JSON object."
    );
}

#[test]
fn override_replaces_top_level_fields_wholesale_and_keeps_the_rest() {
    let (_d, home) = home_with(Some(
        r#"{"providers":{"anthropic":{"apiKey":"$KEY","model":"haiku"},"openai":{"model":"gpt-4o"}},"defaultProvider":"anthropic"}"#,
    ));
    let config = load_config(
        &home,
        &env(&[(
            "WRAP_CONFIG",
            r#"{"providers":{"anthropic":{"apiKey":"$OTHER"}}}"#,
        )]),
    )
    .unwrap();
    let mut expected = BTreeMapOf::new();
    expected.insert(
        "anthropic".to_string(),
        ProviderEntry {
            api_key: Some("$OTHER".into()),
            ..ProviderEntry::default()
        },
    );
    assert_eq!(config.providers.unwrap(), expected);
    assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
}

type BTreeMapOf = std::collections::BTreeMap<String, ProviderEntry>;
