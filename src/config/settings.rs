//! Registry of user-settable values: which sources each accepts (CLI flag,
//! env var, config file) and its default. The resolver merges sources with
//! the precedence CLI > env > file > default; the help and completion
//! subcommands derive their option lists from the same table.
//!
//! Setting id == config key, except `model`: a virtual setting whose value is
//! normalized into `defaultProvider` and `providers[x].model`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingKind {
    Bool,
    Number,
    Str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Default {
    Bool(bool),
    Number(f64),
    Str(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    Providers,
}

pub struct Setting {
    pub id: &'static str,
    pub kind: SettingKind,
    pub description: &'static str,
    pub usage: Option<&'static str>,
    pub help: Option<&'static str>,
    pub flags: &'static [&'static str],
    pub env: &'static [&'static str],
    pub default: Option<Default>,
    pub completion: Option<CompletionKind>,
}

const MODEL_HELP: &str = "Override the LLM provider and/or model for this invocation.

Formats:
  provider:model   Use a specific provider and model
  provider         Use a provider with its configured model
  :model           Use the default provider with a different model
  model            Smart match: check provider names, then model names

The --provider flag is an alias for --model.";

pub static SETTINGS: &[Setting] = &[
    Setting {
        id: "verbose",
        kind: SettingKind::Bool,
        description: "Enable debug output on stderr",
        usage: Some("w --verbose"),
        help: None,
        flags: &["--verbose"],
        env: &[],
        default: Some(Default::Bool(false)),
        completion: None,
    },
    Setting {
        id: "yolo",
        kind: SettingKind::Bool,
        description: "Skip confirmation dialogs — auto-execute all commands regardless of risk. All safety gates disabled.",
        usage: Some("w --yolo"),
        help: None,
        flags: &["--yolo"],
        env: &["WRAP_YOLO"],
        default: Some(Default::Bool(false)),
        completion: None,
    },
    Setting {
        id: "continue",
        kind: SettingKind::Bool,
        description: "Resume the previous wrap conversation in this invocation.",
        usage: Some("w -c <prompt>"),
        help: None,
        flags: &["-c", "--continue"],
        env: &[],
        default: Some(Default::Bool(false)),
        completion: None,
    },
    Setting {
        id: "noAnimation",
        kind: SettingKind::Bool,
        description: "Disable animations",
        usage: Some("w --no-animation"),
        help: None,
        flags: &["--no-animation"],
        env: &["WRAP_NO_ANIMATION"],
        default: Some(Default::Bool(false)),
        completion: None,
    },
    Setting {
        id: "model",
        kind: SettingKind::Str,
        description: "Override LLM provider/model",
        usage: Some("w --model <provider[:model]>"),
        help: Some(MODEL_HELP),
        flags: &["--model", "--provider"],
        env: &["WRAP_MODEL"],
        default: None,
        completion: Some(CompletionKind::Providers),
    },
    Setting {
        id: "nerdFonts",
        kind: SettingKind::Bool,
        description: "Use Nerd Font glyphs in terminal output",
        usage: None,
        help: None,
        flags: &[],
        env: &["WRAP_NERD_FONTS"],
        default: Some(Default::Bool(false)),
        completion: None,
    },
    Setting {
        id: "logTraces",
        kind: SettingKind::Bool,
        description: "Capture full LLM prompts and wire-level responses in the invocation log. Off by default.",
        usage: Some("w --log-traces"),
        help: None,
        flags: &["--log-traces"],
        env: &["WRAP_LOG_TRACES"],
        default: Some(Default::Bool(false)),
        completion: None,
    },
    Setting {
        id: "maxRounds",
        kind: SettingKind::Number,
        description: "Max LLM rounds per prompt before giving up",
        usage: None,
        help: None,
        flags: &[],
        env: &[],
        default: Some(Default::Number(5.0)),
        completion: None,
    },
    Setting {
        id: "maxCapturedOutputChars",
        kind: SettingKind::Number,
        description: "Max chars of command output captured and sent back to the LLM",
        usage: None,
        help: None,
        flags: &[],
        env: &[],
        default: Some(Default::Number(200_000.0)),
        completion: None,
    },
    Setting {
        id: "maxAttachedInputChars",
        kind: SettingKind::Number,
        description: "Max chars of the attached-input preview shown to the LLM (full bytes always on disk at $WRAP_TEMP_DIR/input)",
        usage: None,
        help: None,
        flags: &[],
        env: &[],
        default: Some(Default::Number(200_000.0)),
        completion: None,
    },
    Setting {
        id: "defaultProvider",
        kind: SettingKind::Str,
        description: "Name of the provider used when --model has no provider prefix",
        usage: None,
        help: None,
        flags: &[],
        env: &[],
        default: None,
        completion: None,
    },
];

pub fn setting(id: &str) -> Option<&'static Setting> {
    SETTINGS.iter().find(|s| s.id == id)
}
