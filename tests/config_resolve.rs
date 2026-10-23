use std::collections::{BTreeMap, HashMap};
use wrap::cli::Modifiers;
use wrap::config::{Config, ProviderEntry, ResolvedConfig, apply_model_override, resolve_settings};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn mods(flags: &[&str], values: &[(&str, &str)]) -> Modifiers {
    Modifiers {
        flags: flags.iter().map(|s| s.to_string()).collect(),
        values: values
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

fn file(f: impl FnOnce(&mut Config)) -> Config {
    let mut c = Config::default();
    f(&mut c);
    c
}

fn entry(api_key: &str, model: &str) -> ProviderEntry {
    ProviderEntry {
        api_key: Some(api_key.into()),
        base_url: None,
        model: Some(model.into()),
    }
}

#[test]
fn cli_wins_over_env_and_file() {
    let r = resolve_settings(
        &mods(&["verbose"], &[]),
        &env(&[]),
        &file(|c| c.verbose = Some(false)),
    )
    .unwrap();
    assert!(r.verbose);
    let r = resolve_settings(
        &mods(&["noAnimation"], &[]),
        &env(&[("WRAP_NO_ANIMATION", "0")]),
        &Config::default(),
    )
    .unwrap();
    assert!(r.no_animation);
    let r = resolve_settings(
        &mods(&["yolo"], &[]),
        &env(&[("WRAP_YOLO", "0")]),
        &Config::default(),
    )
    .unwrap();
    assert!(r.yolo);
}

#[test]
fn env_wins_over_file_in_both_directions() {
    let r = resolve_settings(
        &mods(&[], &[]),
        &env(&[("WRAP_NO_ANIMATION", "1")]),
        &file(|c| c.no_animation = Some(false)),
    )
    .unwrap();
    assert!(r.no_animation);
    let r = resolve_settings(
        &mods(&[], &[]),
        &env(&[("WRAP_NERD_FONTS", "0")]),
        &file(|c| c.nerd_fonts = Some(true)),
    )
    .unwrap();
    assert!(!r.nerd_fonts);
}

#[test]
fn file_wins_over_default() {
    let r = resolve_settings(
        &mods(&[], &[]),
        &env(&[]),
        &file(|c| {
            c.verbose = Some(true);
            c.log_traces = Some(true);
            c.yolo = Some(true);
            c.continue_ = Some(true);
            c.max_rounds = Some(10);
        }),
    )
    .unwrap();
    assert!(r.verbose && r.log_traces && r.yolo && r.continue_);
    assert_eq!(r.max_rounds, 10);
}

#[test]
fn defaults_apply_when_every_source_is_silent() {
    let r = resolve_settings(&mods(&[], &[]), &env(&[]), &Config::default()).unwrap();
    assert_eq!(
        r,
        ResolvedConfig {
            providers: BTreeMap::new(),
            default_provider: None,
            max_rounds: 5,
            max_captured_output_chars: 200_000,
            max_attached_input_chars: 200_000,
            verbose: false,
            no_animation: false,
            nerd_fonts: false,
            yolo: false,
            log_traces: false,
            continue_: false,
            appearance: None,
        }
    );
}

#[test]
fn boolean_flags_and_env_vars_switch_their_settings_on() {
    let r = resolve_settings(
        &mods(&["logTraces", "continue"], &[]),
        &env(&[]),
        &Config::default(),
    )
    .unwrap();
    assert!(r.log_traces);
    assert!(r.continue_);
    let r = resolve_settings(
        &mods(&[], &[]),
        &env(&[
            ("WRAP_LOG_TRACES", "1"),
            ("WRAP_YOLO", "1"),
            ("WRAP_NERD_FONTS", "1"),
        ]),
        &Config::default(),
    )
    .unwrap();
    assert!(r.log_traces && r.yolo && r.nerd_fonts);
}

#[test]
fn boolean_env_coercion_accepts_the_documented_spellings() {
    for val in ["1", "true", "yes", "on", "TRUE", "Yes", " on "] {
        let r = resolve_settings(
            &mods(&[], &[]),
            &env(&[("WRAP_NO_ANIMATION", val)]),
            &Config::default(),
        )
        .unwrap();
        assert!(r.no_animation, "env value {val:?}");
    }
    for val in ["0", "false", "no", "off", "", "FALSE", " 0 "] {
        let r = resolve_settings(
            &mods(&[], &[]),
            &env(&[("WRAP_NO_ANIMATION", val)]),
            &Config::default(),
        )
        .unwrap();
        assert!(!r.no_animation, "env value {val:?}");
    }
}

#[test]
fn unrecognized_boolean_env_value_is_an_error_naming_the_variable() {
    let err = resolve_settings(
        &mods(&[], &[]),
        &env(&[("WRAP_NO_ANIMATION", "maybe")]),
        &Config::default(),
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Config error: WRAP_NO_ANIMATION expected 1/true/yes/on or 0/false/no/off, got \"maybe\"."
    );
}

#[test]
fn cli_number_values_parse_and_reject_garbage() {
    let r = resolve_settings(
        &mods(&[], &[("maxRounds", "7")]),
        &env(&[]),
        &Config::default(),
    )
    .unwrap();
    assert_eq!(r.max_rounds, 7);
    let err = resolve_settings(
        &mods(&[], &[("maxRounds", "abc")]),
        &env(&[]),
        &Config::default(),
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Config error: maxRounds expected a number, got \"abc\"."
    );
}

#[test]
fn structural_fields_pass_through_from_the_file() {
    let mut providers = BTreeMap::new();
    providers.insert("anthropic".to_string(), entry("sk-test", "claude-opus"));
    let r = resolve_settings(
        &mods(&[], &[]),
        &env(&[]),
        &file(|c| {
            c.providers = Some(providers.clone());
            c.default_provider = Some("anthropic".into());
        }),
    )
    .unwrap();
    assert_eq!(r.providers, providers);
    assert_eq!(r.default_provider.as_deref(), Some("anthropic"));
}

#[test]
fn ci_term_dumb_and_no_color_force_no_animation() {
    for e in [
        env(&[("CI", "true")]),
        env(&[("TERM", "dumb")]),
        env(&[("NO_COLOR", "1")]),
        env(&[("NO_COLOR", "")]),
    ] {
        let r =
            resolve_settings(&mods(&[], &[]), &e, &file(|c| c.no_animation = Some(false))).unwrap();
        assert!(r.no_animation, "{e:?}");
    }
}

#[test]
fn falsy_ci_values_even_with_whitespace_do_not_force_no_animation() {
    for val in [
        "false", "0", "no", "off", "", " false ", "0\n", "\tno", " off ",
    ] {
        let r =
            resolve_settings(&mods(&[], &[]), &env(&[("CI", val)]), &Config::default()).unwrap();
        assert!(!r.no_animation, "CI={val:?}");
    }
    let r = resolve_settings(
        &mods(&[], &[]),
        &env(&[("TERM", "xterm-256color")]),
        &Config::default(),
    )
    .unwrap();
    assert!(!r.no_animation);
}

#[test]
fn model_override_is_not_applied_by_resolve_settings() {
    let r = resolve_settings(
        &mods(&[], &[("model", "anthropic:claude-opus")]),
        &env(&[("WRAP_MODEL", "openai")]),
        &Config::default(),
    )
    .unwrap();
    assert_eq!(r.default_provider, None);
    assert!(r.providers.is_empty());
}

fn base_config() -> ResolvedConfig {
    let mut providers = BTreeMap::new();
    providers.insert("anthropic".to_string(), entry("sk-a", "claude-haiku-4-5"));
    providers.insert("openai".to_string(), entry("sk-o", "gpt-4o-mini"));
    ResolvedConfig {
        providers,
        default_provider: Some("anthropic".into()),
        ..resolve_settings(&mods(&[], &[]), &env(&[]), &Config::default()).unwrap()
    }
}

#[test]
fn no_override_leaves_config_unchanged() {
    let base = base_config();
    assert_eq!(
        apply_model_override(base.clone(), &mods(&[], &[]), &env(&[])).unwrap(),
        base
    );
    assert_eq!(
        apply_model_override(base.clone(), &mods(&[], &[]), &env(&[("WRAP_MODEL", "")])).unwrap(),
        base
    );
}

#[test]
fn cli_override_sets_default_provider_and_transient_model() {
    let r = apply_model_override(
        base_config(),
        &mods(&[], &[("model", "openai:gpt-4.1")]),
        &env(&[]),
    )
    .unwrap();
    assert_eq!(r.default_provider.as_deref(), Some("openai"));
    assert_eq!(r.providers["openai"].model.as_deref(), Some("gpt-4.1"));
    assert_eq!(r.providers["openai"].api_key.as_deref(), Some("sk-o"));
    assert_eq!(
        r.providers["anthropic"].model.as_deref(),
        Some("claude-haiku-4-5")
    );
}

#[test]
fn env_override_applies_when_cli_absent_and_cli_wins_otherwise() {
    let r = apply_model_override(
        base_config(),
        &mods(&[], &[]),
        &env(&[("WRAP_MODEL", "openai")]),
    )
    .unwrap();
    assert_eq!(r.default_provider.as_deref(), Some("openai"));
    assert_eq!(r.providers["openai"].model.as_deref(), Some("gpt-4o-mini"));
    let r = apply_model_override(
        base_config(),
        &mods(&[], &[("model", "anthropic")]),
        &env(&[("WRAP_MODEL", "openai")]),
    )
    .unwrap();
    assert_eq!(r.default_provider.as_deref(), Some("anthropic"));
}

#[test]
fn bare_values_smart_match_or_fall_through_to_the_default_provider() {
    let r = apply_model_override(
        base_config(),
        &mods(&[], &[("model", "gpt-4o-mini")]),
        &env(&[]),
    )
    .unwrap();
    assert_eq!(r.default_provider.as_deref(), Some("openai"));
    let r = apply_model_override(
        base_config(),
        &mods(&[], &[("model", "custom-llama")]),
        &env(&[]),
    )
    .unwrap();
    assert_eq!(r.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(
        r.providers["anthropic"].model.as_deref(),
        Some("custom-llama")
    );
}

#[test]
fn invalid_override_propagates_the_parse_error() {
    assert_eq!(
        apply_model_override(base_config(), &mods(&[], &[("model", "")]), &env(&[])).unwrap_err(),
        "Config error: --model value is empty."
    );
}

#[test]
fn transient_model_with_no_provider_to_target_is_actionable() {
    let mut no_default = base_config();
    no_default.default_provider = None;
    let err = apply_model_override(no_default, &mods(&[], &[("model", ":gpt-4o")]), &env(&[]))
        .unwrap_err();
    assert_eq!(
        err,
        "Config error: --model \":gpt-4o\" has no provider to target. Set defaultProvider in config or use provider:model."
    );
}
