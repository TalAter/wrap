//! The wizard entry points: when it is needed, the models URL override, and
//! the plain-language refusal when there is no terminal to draw on.

use std::collections::HashMap;

use wrap::home::WrapHome;
use wrap::theme::DARK;
use wrap::wizard::{NO_TERMINAL_ERROR, models_url, needed, run};

#[test]
fn needed_only_when_config_is_absent_and_no_override_is_set() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let env = HashMap::new();
    assert!(needed(&home, &env));
    let overridden = HashMap::from([("WRAP_CONFIG".to_string(), "{}".to_string())]);
    assert!(!needed(&home, &overridden));
    let blank = HashMap::from([("WRAP_CONFIG".to_string(), String::new())]);
    assert!(needed(&home, &blank));
    home.write("config.jsonc", "{ not json").unwrap();
    assert!(
        !needed(&home, &env),
        "a broken file is the loader's to report"
    );
    home.write("config.jsonc", "{}").unwrap();
    assert!(!needed(&home, &env));
}

#[test]
fn models_url_defaults_to_models_dev() {
    assert_eq!(models_url(&HashMap::new()), "https://models.dev/api.json");
    let blank = HashMap::from([("WRAP_MODELS_URL".to_string(), "  ".to_string())]);
    assert_eq!(models_url(&blank), "https://models.dev/api.json");
}

#[cfg(debug_assertions)]
#[test]
fn debug_builds_honor_the_models_url_override() {
    let env = HashMap::from([(
        "WRAP_MODELS_URL".to_string(),
        " http://127.0.0.1:1/ ".to_string(),
    )]);
    assert_eq!(models_url(&env), "http://127.0.0.1:1/");
}

#[test]
fn running_without_a_terminal_is_a_config_error_and_writes_nothing() {
    use std::io::IsTerminal;
    if std::io::stderr().is_terminal() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let err = rt
        .block_on(run(&home, &HashMap::new(), &DARK, false))
        .unwrap_err();
    assert_eq!(err, NO_TERMINAL_ERROR);
    assert_eq!(
        NO_TERMINAL_ERROR,
        "Config error: no config found. Run wrap in a terminal to set one up."
    );
    assert!(!home.exists("config.jsonc"));
    assert!(!home.exists("config.schema.json"));
}
