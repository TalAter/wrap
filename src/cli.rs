//! argv parsing: leading modifier flags, then the input (prompt, subcommand
//! flag, or nothing).

use std::collections::{HashMap, HashSet};

use crate::config::settings::{SETTINGS, SettingKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    /// Natural-language prompt (args joined with single spaces).
    Prompt(String),
    /// A subcommand flag such as `--log`, with everything after it as args.
    Flag {
        flag: String,
        args: Vec<String>,
    },
    None,
}

/// One modifier the parser recognizes. `name` is the key written into
/// `Modifiers`; `flags` are the CLI spellings mapping to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModifierSpec {
    pub name: &'static str,
    pub flags: Vec<&'static str>,
    /// `--flag value` / `--flag=value` when true; a boolean toggle when false.
    pub takes_value: bool,
}

/// Extracted modifiers: boolean toggles in `flags`, value-taking ones in `values`.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub struct Modifiers {
    pub flags: HashSet<String>,
    pub values: HashMap<String, String>,
}

/// Modifier specs for every setting that declares CLI flags.
pub fn modifier_specs() -> Vec<ModifierSpec> {
    SETTINGS
        .iter()
        .filter(|s| !s.flags.is_empty())
        .map(|s| ModifierSpec {
            name: s.id,
            flags: s.flags.to_vec(),
            takes_value: s.kind != SettingKind::Bool,
        })
        .collect()
}

/// Parse argv (without the program name). Only leading args matching a spec
/// are consumed as modifiers; the first non-match starts the input.
pub fn parse_args(args: &[String], specs: &[ModifierSpec]) -> Result<(Modifiers, Input), String> {
    let (modifiers, remaining) = extract_modifiers(args, specs)?;
    Ok((modifiers, parse_input(remaining)))
}

fn extract_modifiers<'a>(
    args: &'a [String],
    specs: &[ModifierSpec],
) -> Result<(Modifiers, &'a [String]), String> {
    let flag_to_spec: HashMap<&str, &ModifierSpec> = specs
        .iter()
        .flat_map(|spec| spec.flags.iter().map(move |f| (*f, spec)))
        .collect();

    let mut modifiers = Modifiers::default();
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        let (flag_name, inline_value) = match arg.find('=') {
            Some(idx) if idx > 0 => (&arg[..idx], Some(&arg[idx + 1..])),
            _ => (arg.as_str(), None),
        };
        let Some(spec) = flag_to_spec.get(flag_name) else {
            break;
        };

        if !spec.takes_value {
            if inline_value.is_some() {
                return Err(format!("Config error: {flag_name} does not take a value."));
            }
            modifiers.flags.insert(spec.name.to_string());
            i += 1;
            continue;
        }

        match inline_value {
            Some(value) => {
                modifiers
                    .values
                    .insert(spec.name.to_string(), value.to_string());
                i += 1;
            }
            None => {
                // A following modifier flag is not a value: `--model --verbose`
                // must not silently consume `--verbose`.
                let next = args
                    .get(i + 1)
                    .filter(|next| !flag_to_spec.contains_key(next.as_str()))
                    .ok_or_else(|| format!("Config error: {arg} requires a value."))?;
                modifiers.values.insert(spec.name.to_string(), next.clone());
                i += 2;
            }
        }
    }
    Ok((modifiers, &args[i..]))
}

fn parse_input(args: &[String]) -> Input {
    let Some(first) = args.first() else {
        return Input::None;
    };
    if first.starts_with('-') {
        return Input::Flag {
            flag: first.clone(),
            args: args[1..].to_vec(),
        };
    }
    Input::Prompt(args.join(" "))
}
