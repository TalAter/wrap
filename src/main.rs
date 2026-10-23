use std::process::ExitCode;

use wrap::app;
use wrap::chrome::chrome;
use wrap::cli::{Input, modifier_specs, parse_args};
use wrap::config::{Config, resolve_settings, store};
use wrap::eval_bridge;
use wrap::home::WrapHome;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let env = app::process_env();
    let code = match run(&args, &env).await {
        Ok(code) => code,
        Err(message) => {
            chrome(&message, None);
            1
        }
    };
    std::process::exit(code)
}

/// Parse argv and dispatch: the eval bridge, a subcommand flag, or a query.
async fn run(
    args: &[String],
    env: &std::collections::HashMap<String, String>,
) -> Result<i32, String> {
    let home = WrapHome::from_env(env);
    if args.first().is_some_and(|first| first == eval_bridge::FLAG) {
        return Ok(eval_bridge::run_from_stdin(&home, env).await);
    }
    let (modifiers, input) = parse_args(args, &modifier_specs())?;

    // `--version` is plain stdout: no theme, so no background probe whose
    // late reply could leak into the shell after wrap exits.
    let is_version =
        matches!(&input, Input::Flag { flag, .. } if flag == "--version" || flag == "-v");
    if !is_version {
        app::apply_appearance(&home, env, None);
    }

    // CLI + env + defaults seed the store before any config file is read;
    // the query path layers the file in and re-resolves.
    store::set_config(resolve_settings(&modifiers, env, &Config::default())?);

    match input {
        Input::Flag { flag, args } => {
            let config = store::get_config();
            Ok(app::dispatch_subcommand(&flag, &args, &home, env, &config))
        }
        other => app::run_query(other, &modifiers, &home, env).await,
    }
}
