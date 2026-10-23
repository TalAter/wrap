//! One invocation from parsed input to exit code: theme, subcommand
//! dispatch, continuation lookup, piped input, config and first-run setup,
//! provider, memory, then the session. `main` parses argv and hands off here.
//!
//! Order matters and is deliberate: continuation is resolved before stdin is
//! read so a refusal exits with no side effects; help wins when there is
//! nothing to work with; the config gate runs before anything that needs a
//! provider; the appearance is resolved twice (before config for `--help`
//! and the wizard, again with the configured appearance) through the disk
//! cache so at most one terminal probe fires per run.

use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use crate::ansi::color_level;
use crate::attached_input::{build_attached_input_preview, read_attached_stdin};
use crate::chrome::{chrome, verbose};
use crate::cli::{Input, Modifiers};
use crate::config::{
    AppearanceSetting, Config, ResolvedConfig, apply_model_override, load_config, resolve_provider,
    resolve_settings, store,
};
use crate::home::WrapHome;
use crate::llm::init_llm;
use crate::logging::{
    LogEntry, Turn, assemble_continuation_chain, find_continuation_parent, read_log_entries,
};
use crate::memory::{ChromeInitUi, ensure_memory};
use crate::paths;
use crate::session::{ContinuationParent, SessionOptions, run_session};
use crate::skills::bundled_skills;
use crate::subcommands::{self, Bucket, Context, Footprints};
use crate::temp::{ensure_temp_dir, format_size};
use crate::theme::{Appearance, detect_appearance, set_theme};
use crate::tui::forget_dialog::{ForgetOutcome, show_forget_dialog_blocking};
use crate::tui::host::TuiHost;
use crate::wizard;

pub const NO_PREVIOUS_RUN: &str = "Continue error: no previous wrap run found.";
pub const PARENT_HAD_PIPE: &str =
    "Continue error: previous run had piped input that's no longer available.";
pub const CONFIGURED_NOTICE: &str = "✓ wrap configured — run w again to start wrapping";

/// The shell's exit code for a process ended by `signal`: a dialog that a
/// signal closed still tears down gracefully, and the process then exits
/// with this so wrappers and CI observe the interruption.
pub fn signal_exit_code(signal: i32) -> i32 {
    128 + signal
}

/// The process environment as owned strings; built once per invocation.
pub fn process_env() -> HashMap<String, String> {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// Resolve the appearance (`WRAP_THEME` → `config` → cache → probe → dark),
/// cache a probe result, and make it the active theme.
pub fn apply_appearance(
    home: &WrapHome,
    env: &HashMap<String, String>,
    configured: Option<AppearanceSetting>,
) {
    let configured = match configured {
        Some(AppearanceSetting::Dark) => Some(Appearance::Dark),
        Some(AppearanceSetting::Light) => Some(Appearance::Light),
        Some(AppearanceSetting::Auto) | None => None,
    };
    let detected = detect_appearance(home.root(), env, configured);
    detected.persist(home.root());
    set_theme(detected.appearance);
}

/// Run a `--flag` subcommand with the real process facts and return its exit
/// code. `config` is the pre-file resolution (CLI + env + defaults).
pub fn dispatch_subcommand(
    flag: &str,
    args: &[String],
    home: &WrapHome,
    env: &HashMap<String, String>,
    config: &ResolvedConfig,
) -> i32 {
    let stderr_is_tty = std::io::stderr().is_terminal();
    let which = |cmd: &str| paths::which(cmd).is_some();
    let interrupted = std::cell::Cell::new(None);
    let forget_dialog = |footprints: &Footprints| -> Option<Vec<Bucket>> {
        let level = color_level(stderr_is_tty, env);
        match show_forget_dialog_blocking(
            footprints,
            crate::theme::get_theme(),
            level,
            config.nerd_fonts,
        ) {
            Ok(ForgetOutcome::Selected(buckets)) => Some(buckets),
            Ok(ForgetOutcome::Cancelled) => None,
            Ok(ForgetOutcome::Interrupted(signal)) => {
                interrupted.set(Some(signal));
                None
            }
            Err(error) => {
                chrome(
                    &format!("Forget error: could not open the dialog: {error}."),
                    None,
                );
                None
            }
        }
    };
    let ctx = Context {
        home,
        env,
        config,
        stdout_is_tty: std::io::stdout().is_terminal(),
        stdin_is_tty: std::io::stdin().is_terminal(),
        terminal_rows: crossterm::terminal::size().ok().map(|(_, rows)| rows),
        which: &which,
        forget_dialog: &forget_dialog,
    };
    let code = subcommands::dispatch(flag, args, &ctx);
    interrupted.get().map_or(code, signal_exit_code)
}

/// `-c` was set: the parent entry, its chain and the root prompt. Refuses
/// when there is no log or the parent's stdin cannot be replayed.
pub fn resolve_continuation(home: &WrapHome, ppid: u32) -> Result<ContinuationParent, String> {
    let entries = read_log_entries(home);
    let parent: &LogEntry =
        find_continuation_parent(&entries, ppid).ok_or_else(|| NO_PREVIOUS_RUN.to_string())?;
    if parent.attached_input.is_some() {
        return Err(PARENT_HAD_PIPE.to_string());
    }
    let assembled_turns = assemble_continuation_chain(&entries, parent);
    let parent_prompt = parent
        .turns
        .iter()
        .find_map(|turn| match turn {
            Turn::User { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default();
    Ok(ContinuationParent {
        parent_id: parent.id.clone(),
        assembled_turns,
        parent_prompt,
    })
}

/// What the config gate decided.
pub enum ConfigGate {
    /// The on-disk (or `WRAP_CONFIG`) config to resolve settings from.
    Ready(Config),
    /// The wizard ended the run: cancelled, or configured with nothing to do.
    Exit(i32),
}

/// Load the config, or run the first-run wizard when there is none. A fresh
/// config with no request to run (`nothing_to_run`) prints the configured
/// notice and exits cleanly instead of launching the composer.
pub async fn ensure_config(
    home: &WrapHome,
    env: &HashMap<String, String>,
    nothing_to_run: bool,
    no_animation: bool,
) -> Result<ConfigGate, String> {
    if wizard::needed(home, env) {
        if !std::io::stderr().is_terminal() {
            return Err(wizard::NO_TERMINAL_ERROR.to_string());
        }
        match wizard::run(home, env, crate::theme::get_theme(), no_animation).await? {
            wizard::Outcome::Cancelled => return Ok(ConfigGate::Exit(0)),
            wizard::Outcome::Interrupted(signal) => {
                return Ok(ConfigGate::Exit(signal_exit_code(signal)));
            }
            wizard::Outcome::Completed(_) if nothing_to_run => {
                chrome(CONFIGURED_NOTICE, None);
                return Ok(ConfigGate::Exit(0));
            }
            wizard::Outcome::Completed(_) => {}
        }
    }
    load_config(home, env)
        .map(ConfigGate::Ready)
        .map_err(|e| format!("Config error: {e}"))
}

/// Piped stdin saved to `$WRAP_TEMP_DIR/input`.
pub struct AttachedInput {
    pub path: String,
    pub size: u64,
    pub preview: String,
    pub truncated: bool,
}

/// Write the piped bytes to the scratch dir as a 0600 file, created with
/// that mode so no wider window exists, then chmod'ed so the mode is exact
/// under any umask.
pub fn materialize_attached_input(bytes: &[u8], max_chars: usize) -> Result<AttachedInput, String> {
    let save_error =
        |e: std::io::Error| format!("Input error: could not save the piped input ({e}).");
    let dir = ensure_temp_dir().map_err(save_error)?;
    let path = dir.join("input");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(save_error)?;
    file.write_all(bytes).map_err(save_error)?;
    file.flush().map_err(save_error)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(save_error)?;
    let built = build_attached_input_preview(bytes, max_chars);
    Ok(AttachedInput {
        path: path.to_string_lossy().into_owned(),
        size: bytes.len() as u64,
        preview: built.preview,
        truncated: built.truncated,
    })
}

/// The current directory in canonical form (the form memory scopes use).
pub fn current_dir() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir()
        .map_err(|_| "Could not determine the current directory.".to_string())?;
    Ok(paths::resolve_path(&cwd.to_string_lossy(), None).unwrap_or(cwd))
}

/// Everything after subcommand dispatch: a natural-language query (or an
/// empty prompt for a pipe or the interactive composer) through the
/// session. The config store holds the pre-file resolution on entry and the
/// full resolution afterwards.
pub async fn run_query(
    input: Input,
    modifiers: &Modifiers,
    home: &WrapHome,
    env: &HashMap<String, String>,
) -> Result<i32, String> {
    let continuation = if store::get_config().continue_ {
        Some(resolve_continuation(
            home,
            std::os::unix::process::parent_id(),
        )?)
    } else {
        None
    };

    let attached_bytes = read_attached_stdin();
    let stdin_is_tty = std::io::stdin().is_terminal();

    // Nothing to work with: no args, no pipe, no terminal (scripts, cron).
    if matches!(input, Input::None) && attached_bytes.is_none() && !stdin_is_tty {
        let config = store::get_config();
        return Ok(dispatch_subcommand("--help", &[], home, env, &config));
    }

    let prompt = match &input {
        Input::Prompt(prompt) => prompt.clone(),
        Input::Flag { .. } | Input::None => String::new(),
    };

    let nothing_to_run = matches!(input, Input::None) && attached_bytes.is_none();
    let file_config =
        match ensure_config(home, env, nothing_to_run, store::get_config().no_animation).await? {
            ConfigGate::Ready(config) => config,
            ConfigGate::Exit(code) => return Ok(code),
        };
    let base = resolve_settings(modifiers, env, &file_config)?;
    store::set_config(apply_model_override(base, modifiers, env)?);
    let config = store::get_config();

    apply_appearance(home, env, config.appearance);

    let provider = resolve_provider(&config, env)?;
    verbose(config.verbose, "Config loaded");

    // One handle per invocation: memory init and the session share it (and,
    // for the test provider, its playback cursor).
    let llm = init_llm(provider.clone(), env).map_err(|e| format!("Config error: {e}"))?;
    verbose(
        config.verbose,
        &format!("Provider initialized ({})", llm.label()),
    );

    let attached = match &attached_bytes {
        Some(bytes) => {
            let attached = materialize_attached_input(bytes, config.max_attached_input_chars)?;
            verbose(
                config.verbose,
                &format!(
                    "Input file: {} ({})",
                    attached.path,
                    format_size(attached.size)
                ),
            );
            Some(attached)
        }
        None => None,
    };

    let memory = ensure_memory(
        home,
        &llm,
        &ChromeInitUi {
            verbose: config.verbose,
        },
    )
    .await?;

    let cwd = current_dir()?;
    let input_source = match (&input, &attached) {
        (Input::Prompt(_), _) => "argv",
        (_, Some(_)) => "pipe",
        _ => "argv",
    };

    let mut host = TuiHost::new(
        home.clone(),
        env.clone(),
        config.nerd_fonts,
        config.no_animation,
    );
    let code = run_session(
        prompt,
        &llm,
        SessionOptions {
            home: home.clone(),
            config: (*config).clone(),
            memory: Some(memory),
            cwd,
            resolved_provider: provider,
            skills: Some(bundled_skills()),
            attached_input_path: attached.as_ref().map(|a| a.path.clone()),
            attached_input_size: attached.as_ref().map(|a| a.size),
            attached_input_preview: attached.as_ref().map(|a| a.preview.clone()),
            attached_input_truncated: attached.as_ref().is_some_and(|a| a.truncated),
            input_source: Some(input_source.to_string()),
            continuation_parent: continuation,
        },
        &mut host,
    )
    .await?;
    Ok(host.signal_received().map_or(code, signal_exit_code))
}
