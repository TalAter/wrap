use std::collections::{BTreeMap, HashMap};
use wrap::config::{
    Config, ProviderEntry, WizardResult, existing_config, write_schema, write_wizard_config,
};
use wrap::home::WrapHome;

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

fn result(
    entries: &[(&str, ProviderEntry)],
    default: &str,
    nerd_fonts: Option<bool>,
) -> WizardResult {
    WizardResult {
        entries: entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect::<BTreeMap<_, _>>(),
        default_provider: default.to_string(),
        nerd_fonts,
    }
}

fn anthropic() -> (&'static str, ProviderEntry) {
    (
        "anthropic",
        entry(Some("sk-ant"), None, Some("claude-sonnet-4-6")),
    )
}

#[test]
fn existing_config_is_none_without_a_file_or_override() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    assert_eq!(existing_config(&home, &env(&[])).unwrap(), None);
    assert_eq!(
        existing_config(&home, &env(&[("WRAP_CONFIG", "")])).unwrap(),
        None
    );
}

#[test]
fn existing_config_loads_the_file_even_when_it_has_no_providers() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    home.write(
        "config.jsonc",
        r#"{"providers":{"anthropic":{"apiKey":"sk-test","model":"claude-haiku-4-5"}},"defaultProvider":"anthropic"}"#,
    )
    .unwrap();
    let config = existing_config(&home, &env(&[])).unwrap().unwrap();
    assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(
        config.providers.unwrap()["anthropic"].model.as_deref(),
        Some("claude-haiku-4-5")
    );

    home.write("config.jsonc", "{}").unwrap();
    assert_eq!(
        existing_config(&home, &env(&[])).unwrap(),
        Some(Config::default())
    );
}

#[test]
fn wrap_config_override_counts_as_existing_config() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let config = existing_config(
        &home,
        &env(&[(
            "WRAP_CONFIG",
            r#"{"providers":{"anthropic":{"apiKey":"env-key","model":"claude-haiku-4-5"}},"defaultProvider":"anthropic"}"#,
        )]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        config.providers.unwrap()["anthropic"].api_key.as_deref(),
        Some("env-key")
    );
}

#[test]
fn existing_config_surfaces_a_broken_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    home.write("config.jsonc", "{ broken").unwrap();
    assert_eq!(
        existing_config(&home, &env(&[])).unwrap_err(),
        "config.jsonc contains invalid JSON."
    );
}

#[test]
fn writes_config_jsonc_byte_for_byte_like_the_wizard_always_has() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    write_wizard_config(&home, &result(&[anthropic()], "anthropic", None)).unwrap();
    assert_eq!(
        home.read("config.jsonc").unwrap().unwrap(),
        r#"{
  "$schema": "./config.schema.json",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant",
      "model": "claude-sonnet-4-6"
    }
  },
  "defaultProvider": "anthropic",
  "nerdFonts": false
}"#
    );
}

#[test]
fn writes_every_provider_the_chosen_default_and_nerd_fonts() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    write_wizard_config(
        &home,
        &result(
            &[
                anthropic(),
                ("openai", entry(Some("sk-o"), None, Some("gpt-5"))),
                ("claude-code", entry(None, None, None)),
            ],
            "openai",
            Some(true),
        ),
    )
    .unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&home.read("config.jsonc").unwrap().unwrap()).unwrap();
    assert_eq!(parsed["$schema"], "./config.schema.json");
    assert_eq!(parsed["defaultProvider"], "openai");
    assert_eq!(parsed["nerdFonts"], true);
    assert_eq!(
        parsed["providers"]["openai"],
        serde_json::json!({"apiKey": "sk-o", "model": "gpt-5"})
    );
    assert_eq!(parsed["providers"]["claude-code"], serde_json::json!({}));
    assert_eq!(parsed["providers"].as_object().unwrap().len(), 3);
}

#[test]
fn invalid_entries_are_rejected_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let err = write_wizard_config(
        &home,
        &result(
            &[("ollama", entry(None, None, Some("llama3.2")))],
            "ollama",
            None,
        ),
    )
    .unwrap_err();
    assert_eq!(err, "Config error: provider \"ollama\" requires baseURL.");
    let err = write_wizard_config(
        &home,
        &result(
            &[("custom", entry(None, None, Some("foo")))],
            "custom",
            None,
        ),
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Config error: provider \"custom\" requires baseURL, apiKey, and model."
    );
    assert!(!home.exists("config.jsonc"));
}

#[test]
fn written_config_round_trips_through_load() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    write_wizard_config(&home, &result(&[anthropic()], "anthropic", Some(true))).unwrap();
    let config = wrap::config::load_config(&home, &env(&[])).unwrap();
    assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(config.nerd_fonts, Some(true));
    assert_eq!(config.providers.unwrap()["anthropic"], anthropic().1);
}

#[test]
fn write_schema_emits_the_bundled_json_schema() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    write_schema(&home).unwrap();
    let raw = home.read("config.schema.json").unwrap().unwrap();
    let schema: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(schema["$schema"].as_str().unwrap().contains("json-schema"));
    assert_eq!(
        schema["properties"]["appearance"]["enum"],
        serde_json::json!(["auto", "dark", "light"])
    );
    assert!(raw.contains("\n  \"properties\": {"), "2-space indented");
}
