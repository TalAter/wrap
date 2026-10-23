//! Configuration: the on-disk `config.jsonc` shape, the settings registry,
//! source precedence (CLI > env > file > default), the resolved provider, and
//! the process-wide config store.

pub mod providers;
pub mod settings;
pub mod store;

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::Modifiers;
use crate::home::WrapHome;
use providers::{is_known_provider, registration, validate_provider_entry};
use settings::{Default as SettingDefault, Setting, SettingKind};

pub const CONFIG_FILENAME: &str = "config.jsonc";
const SCHEMA_FILENAME: &str = "config.schema.json";
const CONFIG_OVERRIDE_VAR: &str = "WRAP_CONFIG";
const NO_LLM_ERROR: &str = "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.";

/// One entry in the `providers` map of `config.jsonc`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderEntry {
    #[serde(rename = "apiKey", default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "baseURL", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub type Providers = BTreeMap<String, ProviderEntry>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppearanceSetting {
    Auto,
    Dark,
    Light,
}

/// The on-disk shape: every field optional, unknown top-level keys kept in `extra`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<Providers>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_captured_output_chars: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attached_input_chars: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_animation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nerd_fonts: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yolo: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_traces: Option<bool>,
    /// Per-invocation only: resume the previous wrap conversation.
    #[serde(rename = "continue", default, skip_serializing_if = "Option::is_none")]
    pub continue_: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSetting>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Config after every setting has been resolved to a concrete value.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedConfig {
    pub providers: Providers,
    pub default_provider: Option<String>,
    pub max_rounds: u32,
    pub max_captured_output_chars: usize,
    pub max_attached_input_chars: usize,
    pub verbose: bool,
    pub no_animation: bool,
    pub nerd_fonts: bool,
    pub yolo: bool,
    pub log_traces: bool,
    pub continue_: bool,
    pub appearance: Option<AppearanceSetting>,
}

/// The provider an invocation talks to: what the LLM layer is built from and
/// what the log entry records.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedProvider {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "apiKey", default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "baseURL", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/// Load `config.jsonc` (JSONC: comments and trailing commas) and fold the
/// `WRAP_CONFIG` env override over it. The override is strict JSON and
/// shallow-merges: each of its top-level fields replaces the file's wholesale,
/// so a nested `providers` object is never deep-merged. An absent or empty
/// file is the default config.
pub fn load_config(home: &WrapHome, env: &HashMap<String, String>) -> Result<Config, String> {
    let file = load_file_value(home)?;
    validate_shape(&file, CONFIG_FILENAME)?;

    let Some(overlay) = load_override_value(env)? else {
        return Ok(from_value(file));
    };
    validate_shape(&overlay, CONFIG_OVERRIDE_VAR)?;

    let mut merged = file.as_object().cloned().unwrap_or_default();
    if let Some(overlay) = overlay.as_object() {
        merged.extend(overlay.clone());
    }
    Ok(from_value(Value::Object(merged)))
}

fn load_file_value(home: &WrapHome) -> Result<Value, String> {
    let raw = match home.read(CONFIG_FILENAME) {
        Ok(Some(raw)) => raw,
        Ok(None) => return Ok(Value::Object(Default::default())),
        Err(_) => return Err(format!("could not read {CONFIG_FILENAME}.")),
    };
    let options = jsonc_parser::ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
        allow_bare_decimal_point_numbers: false,
        allow_non_finite_numbers: false,
        allow_extended_string_escapes: false,
    };
    let parsed = jsonc_parser::parse_to_serde_value::<Option<Value>>(&raw, &options)
        .map_err(|_| format!("{CONFIG_FILENAME} contains invalid JSON."))?;
    Ok(parsed.unwrap_or_else(|| Value::Object(Default::default())))
}

fn load_override_value(env: &HashMap<String, String>) -> Result<Option<Value>, String> {
    let Some(raw) = env
        .get(CONFIG_OVERRIDE_VAR)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    serde_json::from_str(raw)
        .map(Some)
        .map_err(|_| format!("{CONFIG_OVERRIDE_VAR} contains invalid JSON."))
}

/// A source must be a JSON object whose known keys carry the right types.
/// Each source is checked on its own so the message names the right one.
fn validate_shape(value: &Value, source: &str) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err(format!("{source} must contain a JSON object."));
    };
    if serde_json::from_value::<Config>(value.clone()).is_ok() {
        return Ok(());
    }
    let offending = object
        .iter()
        .find(|(key, field)| {
            let mut single = serde_json::Map::new();
            single.insert((*key).clone(), (*field).clone());
            serde_json::from_value::<Config>(Value::Object(single)).is_err()
        })
        .map(|(key, _)| key.as_str())
        .unwrap_or("a setting");
    Err(format!(
        "{source} has an invalid value for \"{offending}\"."
    ))
}

fn from_value(value: Value) -> Config {
    serde_json::from_value(value).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/// Merge CLI modifiers, environment, and file config into a complete config.
/// Precedence per setting: CLI > env > file > default. Structural fields
/// (`providers`, `appearance`) pass through from the file untouched.
///
/// `model` is virtual: its override is normalized into `default_provider` and
/// `providers[name].model` by `apply_model_override`, which needs the
/// populated providers map.
pub fn resolve_settings(
    modifiers: &Modifiers,
    env: &HashMap<String, String>,
    file: &Config,
) -> Result<ResolvedConfig, String> {
    let bool_setting =
        |id: &str, file_value: Option<bool>| resolve_bool(lookup(id), modifiers, env, file_value);
    let number_setting =
        |id: &str, file_value: Option<f64>| resolve_number(lookup(id), modifiers, env, file_value);

    let mut no_animation = bool_setting("noAnimation", file.no_animation)?;
    // Env-wide capability signals force animations off regardless of the
    // per-setting layers: CI redraw logs are garbage, dumb terminals can't
    // move the cursor, and NO_COLOR users want a quiet terminal.
    if is_ci_active(env)
        || env.get("TERM").is_some_and(|t| t == "dumb")
        || env.contains_key("NO_COLOR")
    {
        no_animation = true;
    }

    Ok(ResolvedConfig {
        providers: file.providers.clone().unwrap_or_default(),
        default_provider: resolve_string(
            lookup("defaultProvider"),
            modifiers,
            env,
            file.default_provider.clone(),
        ),
        max_rounds: number_setting("maxRounds", file.max_rounds.map(f64::from))? as u32,
        max_captured_output_chars: number_setting(
            "maxCapturedOutputChars",
            file.max_captured_output_chars.map(|n| n as f64),
        )? as usize,
        max_attached_input_chars: number_setting(
            "maxAttachedInputChars",
            file.max_attached_input_chars.map(|n| n as f64),
        )? as usize,
        verbose: bool_setting("verbose", file.verbose)?,
        no_animation,
        nerd_fonts: bool_setting("nerdFonts", file.nerd_fonts)?,
        yolo: bool_setting("yolo", file.yolo)?,
        log_traces: bool_setting("logTraces", file.log_traces)?,
        continue_: bool_setting("continue", file.continue_)?,
        appearance: file.appearance,
    })
}

fn lookup(id: &str) -> &'static Setting {
    settings::setting(id).unwrap_or_else(|| panic!("unknown setting {id}"))
}

fn env_value<'a>(
    setting: &Setting,
    env: &'a HashMap<String, String>,
) -> Option<(&'static str, &'a str)> {
    setting
        .env
        .iter()
        .find_map(|name| env.get(*name).map(|v| (*name, v.as_str())))
}

fn resolve_bool(
    setting: &Setting,
    modifiers: &Modifiers,
    env: &HashMap<String, String>,
    file_value: Option<bool>,
) -> Result<bool, String> {
    debug_assert_eq!(setting.kind, SettingKind::Bool);
    if modifiers.flags.contains(setting.id) {
        return Ok(true);
    }
    if let Some((name, raw)) = env_value(setting, env) {
        return coerce_bool(raw, name);
    }
    if let Some(v) = file_value {
        return Ok(v);
    }
    Ok(matches!(setting.default, Some(SettingDefault::Bool(true))))
}

fn resolve_number(
    setting: &Setting,
    modifiers: &Modifiers,
    env: &HashMap<String, String>,
    file_value: Option<f64>,
) -> Result<f64, String> {
    debug_assert_eq!(setting.kind, SettingKind::Number);
    if let Some(raw) = modifiers.values.get(setting.id) {
        return coerce_number(raw, setting.id);
    }
    if let Some((name, raw)) = env_value(setting, env) {
        return coerce_number(raw, name);
    }
    if let Some(v) = file_value {
        return Ok(v);
    }
    Ok(match setting.default {
        Some(SettingDefault::Number(n)) => n,
        _ => 0.0,
    })
}

fn resolve_string(
    setting: &Setting,
    modifiers: &Modifiers,
    env: &HashMap<String, String>,
    file_value: Option<String>,
) -> Option<String> {
    debug_assert_eq!(setting.kind, SettingKind::Str);
    if let Some(raw) = modifiers.values.get(setting.id) {
        return Some(raw.clone());
    }
    if let Some((_, raw)) = env_value(setting, env) {
        return Some(raw.to_string());
    }
    if file_value.is_some() {
        return file_value;
    }
    match setting.default {
        Some(SettingDefault::Str(s)) => Some(s.to_string()),
        _ => None,
    }
}

const TRUTHY: &[&str] = &["1", "true", "yes", "on"];
const FALSY: &[&str] = &["0", "false", "no", "off", ""];

fn coerce_bool(raw: &str, source: &str) -> Result<bool, String> {
    let v = raw.trim().to_lowercase();
    if TRUTHY.contains(&v.as_str()) {
        return Ok(true);
    }
    if FALSY.contains(&v.as_str()) {
        return Ok(false);
    }
    Err(format!(
        "Config error: {source} expected 1/true/yes/on or 0/false/no/off, got \"{raw}\"."
    ))
}

fn coerce_number(raw: &str, source: &str) -> Result<f64, String> {
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
        .ok_or_else(|| format!("Config error: {source} expected a number, got \"{raw}\"."))
}

/// CI is presence-ish, but `CI=false` / `CI=0` is a real convention in shells
/// that inherit the variable outside an actual CI run.
fn is_ci_active(env: &HashMap<String, String>) -> bool {
    env.get("CI")
        .is_some_and(|v| !FALSY.contains(&v.trim().to_lowercase().as_str()))
}

// ---------------------------------------------------------------------------
// Model override
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelOverride {
    pub provider_name: Option<String>,
    pub transient_model: Option<String>,
}

/// Resolve the `--model` / `WRAP_MODEL` override and normalize it into
/// `default_provider` and `providers[name].model`. Without an override the
/// config comes back unchanged.
pub fn apply_model_override(
    config: ResolvedConfig,
    modifiers: &Modifiers,
    env: &HashMap<String, String>,
) -> Result<ResolvedConfig, String> {
    let Some(override_) = read_model_override(modifiers, env) else {
        return Ok(config);
    };
    let ModelOverride {
        provider_name,
        transient_model,
    } = parse_model_override(
        override_,
        &config.providers,
        config.default_provider.as_deref(),
    )?;

    // `--model :x` with no defaultProvider to attach the transient model to
    // deserves a specific message rather than the generic NO_LLM_ERROR later.
    let Some(provider_name) = provider_name else {
        return Err(format!(
            "Config error: --model \"{override_}\" has no provider to target. Set defaultProvider in config or use provider:model."
        ));
    };

    let mut next = config;
    if let Some(model) = transient_model {
        next.providers
            .entry(provider_name.clone())
            .or_default()
            .model = Some(model);
    }
    next.default_provider = Some(provider_name);
    Ok(next)
}

/// CLI first, then the setting's env vars; an empty env value counts as absent.
fn read_model_override<'a>(
    modifiers: &'a Modifiers,
    env: &'a HashMap<String, String>,
) -> Option<&'a str> {
    if let Some(cli) = modifiers.values.get("model") {
        return Some(cli.as_str());
    }
    lookup("model")
        .env
        .iter()
        .find_map(|name| env.get(*name).map(String::as_str).filter(|v| !v.is_empty()))
}

/// Parse an override into the provider it targets and an optional transient model.
///
/// - `provider:model` → that provider, that model
/// - `provider` (a configured key) → that provider's stored model
/// - `:model` → the default provider, a different model
/// - bare value → the unique provider configured with that model, else an
///   error for an unconfigured built-in, else the default provider with the
///   value as a transient model
///
/// `provider_name` is `None` only when neither the override nor the config
/// names a provider.
pub fn parse_model_override(
    override_: &str,
    providers: &Providers,
    default_provider: Option<&str>,
) -> Result<ModelOverride, String> {
    let trimmed = override_.trim();
    if trimmed.is_empty() || trimmed == ":" {
        return Err("Config error: --model value is empty.".to_string());
    }
    let default = default_provider.map(str::to_string);
    if let Some((name, model)) = trimmed.split_once(':') {
        return Ok(ModelOverride {
            provider_name: if name.is_empty() {
                default
            } else {
                Some(name.to_string())
            },
            transient_model: (!model.is_empty()).then(|| model.to_string()),
        });
    }
    if providers.contains_key(trimmed) {
        return Ok(ModelOverride {
            provider_name: Some(trimmed.to_string()),
            transient_model: None,
        });
    }
    let mut matches = providers
        .iter()
        .filter(|(_, entry)| entry.model.as_deref() == Some(trimmed))
        .map(|(name, _)| name);
    match (matches.next(), matches.next()) {
        (Some(name), None) => {
            return Ok(ModelOverride {
                provider_name: Some(name.clone()),
                transient_model: None,
            });
        }
        (Some(_), Some(_)) => {
            return Err(format!(
                "Config error: model \"{trimmed}\" is configured for multiple providers; use provider:model."
            ));
        }
        _ => {}
    }
    if is_known_provider(trimmed) {
        return Err(format!(
            "Config error: provider \"{trimmed}\" not found in config."
        ));
    }
    Ok(ModelOverride {
        provider_name: default,
        transient_model: Some(trimmed.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/// True when one of the test-provider env vars is set, regardless of value.
pub fn is_test_provider_selected(env: &HashMap<String, String>) -> bool {
    env.contains_key("WRAP_TEST_RESPONSE") || env.contains_key("WRAP_TEST_RESPONSES")
}

/// Pick the provider for this invocation. `WRAP_TEST_RESPONSE(S)` selects the
/// canned test provider and bypasses the providers map. Otherwise the default
/// provider's entry is validated (existence, per-provider structure, then the
/// model requirement) and returned. Errors are complete user-facing messages.
pub fn resolve_provider(
    config: &ResolvedConfig,
    env: &HashMap<String, String>,
) -> Result<ResolvedProvider, String> {
    if is_test_provider_selected(env) {
        return Ok(ResolvedProvider {
            name: "test".to_string(),
            model: None,
            api_key: None,
            base_url: None,
        });
    }
    let name = config
        .default_provider
        .as_deref()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| NO_LLM_ERROR.to_string())?;
    let entry = config
        .providers
        .get(name)
        .ok_or_else(|| format!("Config error: provider \"{name}\" not found in config."))?;
    if let Some(message) = validate_provider_entry(name, entry) {
        return Err(format!("Config error: {message}"));
    }
    if entry.model.as_deref().is_none_or(str::is_empty) && !registration(name).model_optional {
        return Err(format!(
            "Config error: provider \"{name}\" has no model set in config."
        ));
    }
    Ok(ResolvedProvider {
        name: name.to_string(),
        model: entry.model.clone(),
        api_key: entry.api_key.clone(),
        base_url: entry.base_url.clone(),
    })
}

// ---------------------------------------------------------------------------
// First-run config (non-interactive half of ensure_config)
// ---------------------------------------------------------------------------

/// What the wizard produces.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WizardResult {
    pub entries: Providers,
    pub default_provider: String,
    pub nerd_fonts: Option<bool>,
}

/// The config to use without running the wizard: `Some` when `config.jsonc`
/// exists or `WRAP_CONFIG` is set, `None` when the wizard should run.
pub fn existing_config(
    home: &WrapHome,
    env: &HashMap<String, String>,
) -> Result<Option<Config>, String> {
    let overridden = env.get(CONFIG_OVERRIDE_VAR).is_some_and(|v| !v.is_empty());
    if home.exists(CONFIG_FILENAME) || overridden {
        return load_config(home, env).map(Some);
    }
    Ok(None)
}

/// Validate the wizard's entries and write `config.jsonc`. Nothing is written
/// when an entry would be rejected by provider resolution.
pub fn write_wizard_config(home: &WrapHome, result: &WizardResult) -> Result<(), String> {
    let config = build_config(result)?;
    home.write(CONFIG_FILENAME, &serialize_config(&config))
        .map_err(|e| {
            format!(
                "Config error: could not write {}: {e}",
                home.resolve(CONFIG_FILENAME).display()
            )
        })
}

/// Write the JSON Schema that `config.jsonc` points at via `$schema`.
pub fn write_schema(home: &WrapHome) -> std::io::Result<()> {
    home.write(SCHEMA_FILENAME, include_str!("config.schema.json"))
}

fn build_config(result: &WizardResult) -> Result<Config, String> {
    for (name, entry) in &result.entries {
        if let Some(message) = validate_provider_entry(name, entry) {
            return Err(format!("Config error: {message}"));
        }
    }
    Ok(Config {
        providers: Some(result.entries.clone()),
        default_provider: Some(result.default_provider.clone()),
        nerd_fonts: Some(result.nerd_fonts.unwrap_or(false)),
        ..Config::default()
    })
}

/// The on-disk file: `$schema` first, then the wizard's fields, 2-space indented.
#[derive(Serialize)]
struct ConfigFile<'a> {
    #[serde(rename = "$schema")]
    schema: &'static str,
    #[serde(flatten)]
    config: &'a Config,
}

fn serialize_config(config: &Config) -> String {
    serde_json::to_string_pretty(&ConfigFile {
        schema: "./config.schema.json",
        config,
    })
    .expect("config serializes")
}
