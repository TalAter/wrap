//! First-run setup: when `config.jsonc` is missing, walk the user through
//! the wizard dialog on the stderr alternate screen and write the config
//! and its schema.

pub mod models_dev;
pub mod state;

use std::collections::HashMap;
use std::io::IsTerminal;

use crate::ansi::color_level;
use crate::chrome::chrome;
use crate::config::{self, WizardResult, existing_config, write_schema, write_wizard_config};
use crate::home::WrapHome;
use crate::theme::Theme;
use crate::tui::drive::drive;
use crate::tui::terminal::{SessionSignals, TerminalSession};
use crate::tui::wizard_dialog::{
    ConfigWizardDialog, ModelsLoader, WizardDialogOptions, WizardExit,
};
use models_dev::{MODELS_DEV_URL, fetch_models, on_path, probe_cli_binaries};

/// The refusal when setup is needed but there is no terminal to draw on.
pub const NO_TERMINAL_ERROR: &str =
    "Config error: no config found. Run wrap in a terminal to set one up.";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed(WizardResult),
    /// Esc or Ctrl+C; nothing written.
    Cancelled,
    /// SIGINT/SIGTERM/SIGHUP (the number) ended the wizard; nothing written.
    Interrupted(i32),
}

/// True when no `config.jsonc` exists and `WRAP_CONFIG` is unset. A config
/// that exists but does not parse is left for the loader to report.
pub fn needed(home: &WrapHome, env: &HashMap<String, String>) -> bool {
    matches!(existing_config(home, env), Ok(None))
}

/// Debug builds let tests point the models.dev fetch at a local URL.
#[cfg(debug_assertions)]
pub fn models_url(env: &HashMap<String, String>) -> String {
    env.get("WRAP_MODELS_URL")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map_or_else(|| MODELS_DEV_URL.to_string(), str::to_string)
}

#[cfg(not(debug_assertions))]
pub fn models_url(_env: &HashMap<String, String>) -> String {
    MODELS_DEV_URL.to_string()
}

fn terminal_error(error: std::io::Error) -> String {
    format!("Config error: could not open the terminal for setup: {error}")
}

/// Runs the wizard and, on completion, writes `config.jsonc` and
/// `config.schema.json` and prints the saved confirmation. Cancelling (a
/// key) or a signal writes nothing. A models.dev failure is the
/// plain-language error for `main` to print.
///
/// The nerd-icons answer is pushed into the config store as soon as it is
/// given, so the store must already be seeded by the caller.
pub async fn run(
    home: &WrapHome,
    env: &HashMap<String, String>,
    theme: &'static Theme,
    no_animation: bool,
) -> Result<Outcome, String> {
    if !std::io::stderr().is_terminal() {
        return Err(NO_TERMINAL_ERROR.to_string());
    }
    let url = models_url(env);
    let loader_home = home.clone();
    let loader: ModelsLoader = Box::new(move || {
        let home = loader_home.clone();
        let url = url.clone();
        Box::pin(async move { fetch_models(&home, &url).await })
    });
    let opts = WizardDialogOptions {
        theme,
        color_level: color_level(true, env),
        nerd_fonts: false,
        no_animation,
        cli_available: probe_cli_binaries(|cmd| on_path(env, cmd)),
        models_loader: Some(loader),
        on_nerd_fonts: Some(Box::new(|value| {
            config::store::update_config(|c| c.nerd_fonts = value);
        })),
    };
    let signals = SessionSignals::open().map_err(terminal_error)?;
    let mut terminal = TerminalSession::open().map_err(terminal_error)?;
    let mut dialog = ConfigWizardDialog::new(opts);
    let exit = drive(&mut dialog, &mut terminal, || signals.received())
        .await
        .map_err(terminal_error)?;
    drop(terminal);
    let result = match exit {
        WizardExit::Failed(message) => return Err(message),
        WizardExit::Cancelled => None,
        WizardExit::Done(result) => Some(result),
    };
    if let Some(signal) = signals.signal() {
        return Ok(Outcome::Interrupted(signal));
    }
    let Some(result) = result else {
        return Ok(Outcome::Cancelled);
    };
    write_wizard_config(home, &result)?;
    write_schema(home).map_err(|e| {
        format!(
            "Config error: could not write {}: {e}",
            home.resolve("config.schema.json").display()
        )
    })?;
    chrome("Configuration saved", Some("🧠"));
    Ok(Outcome::Completed(result))
}
