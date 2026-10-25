//! Subcommands: the `--flag` inputs that short-circuit a query (`--help`,
//! `--version`, `--log`, `--completion`, `--forget`). A single registry
//! drives dispatch, help text and shell completion; modifier options are
//! derived from the settings table so the CLI never drifts from config.
//!
//! Commands write their payload to the writer they are given (stdout in the
//! binary) and narrate through [`crate::chrome`], so stdout only ever carries
//! useful output.

use std::collections::HashMap;
use std::io::{self, Write};

use crate::chrome::chrome;
use crate::config::ResolvedConfig;
use crate::home::WrapHome;

pub mod completion;
pub mod forget;
pub mod help;
pub mod log;
pub mod registry;
pub mod version;

pub use forget::{Bucket, Footprints};
pub use registry::{CliFlag, CompletionKind, FlagKind, commands, options};

/// Everything a subcommand may need from the process, passed explicitly so
/// commands never read the environment or probe terminals themselves.
pub struct Context<'a> {
    pub home: &'a WrapHome,
    pub env: &'a HashMap<String, String>,
    /// Scratch root with the original filesystem path bytes preserved.
    pub tmp_base: std::path::PathBuf,
    pub config: &'a ResolvedConfig,
    pub stdout_is_tty: bool,
    pub stdin_is_tty: bool,
    pub terminal_rows: Option<u16>,
    /// Whether an executable is on `PATH`.
    pub which: &'a dyn Fn(&str) -> bool,
    /// Opens the `--forget` checklist; `None` means the user cancelled.
    pub forget_dialog: &'a dyn Fn(&Footprints) -> Option<Vec<Bucket>>,
}

/// Color is welcome when the user has not opted out via `NO_COLOR` and the
/// stream is a terminal, or `FORCE_COLOR` (anything but `0`) says so anyway.
pub fn supports_color(is_tty: bool, env: &HashMap<String, String>) -> bool {
    if env.contains_key("NO_COLOR") {
        return false;
    }
    match env.get("FORCE_COLOR") {
        Some(force) => force != "0",
        None => is_tty,
    }
}

/// Run the command registered for `flag` (or one of its aliases), writing
/// its payload to stdout. Returns the process exit code.
pub fn dispatch(flag: &str, args: &[String], ctx: &Context) -> i32 {
    let mut stdout = io::stdout().lock();
    let code = dispatch_to(flag, args, ctx, &mut stdout);
    let _ = stdout.flush();
    code
}

/// [`dispatch`] with an explicit payload writer.
pub fn dispatch_to(flag: &str, args: &[String], ctx: &Context, out: &mut dyn Write) -> i32 {
    let commands = commands();
    let Some(command) = commands.iter().find(|c| c.matches(flag)) else {
        chrome(&format!("Unknown flag: {flag}"), None);
        return 1;
    };
    match command.id.as_str() {
        "log" => log::run(args, ctx, out),
        "help" => help::run(args, ctx, out),
        "version" => version::run(args, out),
        "completion" => completion::run(args, out),
        "forget" => forget::run(args, ctx, ctx.forget_dialog),
        other => unreachable!("unregistered command id {other}"),
    }
}
