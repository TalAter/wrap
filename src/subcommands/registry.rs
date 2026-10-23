//! The flag registry: commands in help order, plus options derived from
//! every setting that declares CLI flags.

use crate::config::settings::{self, SETTINGS, SettingKind};

use super::{completion, forget, help, log, version};

/// What a flag's value completes to in a shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    Providers,
    Shells,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlagKind {
    /// A subcommand that runs instead of a query.
    Command,
    /// A modifier stripped from argv before the input is parsed.
    Option { takes_value: bool, env: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliFlag {
    pub flag: String,
    pub aliases: Vec<String>,
    pub id: String,
    pub description: String,
    /// `w --flag [args]`; help derives the display hint from it.
    pub usage: String,
    pub help: Option<String>,
    pub completion: Option<CompletionKind>,
    pub kind: FlagKind,
}

impl CliFlag {
    /// Primary flag followed by its aliases.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.flag.as_str()).chain(self.aliases.iter().map(String::as_str))
    }

    pub fn matches(&self, flag: &str) -> bool {
        self.names().any(|n| n == flag)
    }

    /// Whether the flag consumes a value: anything with a completer does,
    /// otherwise only value-taking options.
    pub fn takes_value(&self) -> bool {
        self.completion.is_some()
            || matches!(
                self.kind,
                FlagKind::Option {
                    takes_value: true,
                    ..
                }
            )
    }
}

/// Subcommands in the order help lists them.
pub fn commands() -> Vec<CliFlag> {
    vec![
        log::flag(),
        help::flag(),
        version::flag(),
        completion::flag(),
        forget::flag(),
    ]
}

/// Modifier options, one per setting with CLI flags, in settings order.
pub fn options() -> Vec<CliFlag> {
    SETTINGS
        .iter()
        .filter(|s| !s.flags.is_empty())
        .map(setting_to_option)
        .collect()
}

fn setting_to_option(s: &settings::Setting) -> CliFlag {
    let primary = s.flags[0];
    CliFlag {
        flag: primary.to_string(),
        aliases: s.flags[1..].iter().map(|f| f.to_string()).collect(),
        id: s.id.to_string(),
        description: s.description.to_string(),
        usage: s
            .usage
            .map(str::to_string)
            .unwrap_or_else(|| format!("w {primary}")),
        help: s.help.map(str::to_string),
        completion: s.completion.map(|c| match c {
            settings::CompletionKind::Providers => CompletionKind::Providers,
        }),
        kind: FlagKind::Option {
            takes_value: s.kind != SettingKind::Bool,
            env: s.env.iter().map(|e| e.to_string()).collect(),
        },
    }
}

pub(super) fn command(
    flag: &str,
    aliases: &[&str],
    id: &str,
    description: &str,
    usage: &str,
    help: Option<String>,
    completion: Option<CompletionKind>,
) -> CliFlag {
    CliFlag {
        flag: flag.to_string(),
        aliases: aliases.iter().map(|a| a.to_string()).collect(),
        id: id.to_string(),
        description: description.to_string(),
        usage: usage.to_string(),
        help,
        completion,
        kind: FlagKind::Command,
    }
}
