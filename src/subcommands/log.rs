//! `--log`: print invocation log entries, optionally filtered and limited.
//! Output is useful payload, so it goes to stdout: raw JSONL when piped or
//! asked for, otherwise pretty-printed (through `jq -C` when available).

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::chrome::chrome;
use crate::home::WrapHome;

use super::Context;
use super::registry::{self, CliFlag};

const LOG_FILE: &str = "logs/wrap.jsonl";
const USAGE: &str = "Usage: w --log [search] [N] [--raw]";

pub fn flag() -> CliFlag {
    registry::command(
        "--log",
        &[],
        "log",
        "Show log entries",
        "w --log [search] [N] [--raw]",
        Some(
            "Arguments:\n  search    Filter entries containing this term\n  N         Show only the last N entries\n  --raw     Output raw JSONL instead of pretty-printed"
                .to_string(),
        ),
        None,
    )
}

pub struct LogRead {
    pub valid: Vec<Value>,
    /// Lines that were not JSON.
    pub corrupt: usize,
}

/// Parse the last `n` raw lines of the log (all when `None`). The slice is
/// taken before parsing, so corrupt lines count toward `n`.
pub fn read_log(home: &WrapHome, n: Option<usize>) -> LogRead {
    let content = home.read(LOG_FILE).ok().flatten().unwrap_or_default();
    let content = content.trim_end();
    let mut read = LogRead {
        valid: Vec::new(),
        corrupt: 0,
    };
    if content.is_empty() {
        return read;
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let start = n.map_or(0, |n| lines.len().saturating_sub(n));
    for line in &lines[start..] {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => read.valid.push(value),
            Err(_) => read.corrupt += 1,
        }
    }
    read
}

/// Entries whose serialized JSON contains `term`, case-insensitively.
pub fn search_entries(entries: &[Value], term: &str) -> Vec<Value> {
    let needle = term.to_lowercase();
    entries
        .iter()
        .filter(|e| e.to_string().to_lowercase().contains(&needle))
        .cloned()
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogArgs {
    pub n: Option<usize>,
    pub search: Option<String>,
    pub raw: bool,
}

/// Split `--log` arguments into a count, a search term and the raw switch.
/// `Err` carries the message lines to show the user.
pub fn parse_log_args(args: &[String]) -> Result<LogArgs, Vec<String>> {
    let mut parsed = LogArgs {
        n: None,
        search: None,
        raw: false,
    };
    for arg in args {
        if arg == "--raw" {
            parsed.raw = true;
        } else if is_negative_integer(arg) {
            return Err(vec![
                "Invalid argument: N must be a non-negative integer.".into(),
                USAGE.into(),
            ]);
        } else if let Some(n) = canonical_count(arg) {
            parsed.n = Some(n);
        } else if arg.is_empty() {
            // Nothing to search for.
        } else if parsed.search.is_none() {
            parsed.search = Some(arg.clone());
        } else {
            return Err(vec!["Only one search term allowed.".into(), USAGE.into()]);
        }
    }
    Ok(parsed)
}

fn is_negative_integer(arg: &str) -> bool {
    arg.strip_prefix('-')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// `arg` as a count only when it is the canonical spelling of a
/// non-negative integer: no sign, no leading zeros, nothing trailing.
fn canonical_count(arg: &str) -> Option<usize> {
    let n: usize = arg.parse().ok()?;
    (n.to_string() == arg).then_some(n)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputMode {
    /// One compact JSON object per line.
    Raw,
    /// Colorized through a `jq -C .` subprocess.
    Jq,
    /// Two-space indented JSON, entries separated by blank lines.
    Pretty,
}

pub fn output_mode(raw: bool, stdout_is_tty: bool, has_jq: bool) -> OutputMode {
    if raw || !stdout_is_tty {
        OutputMode::Raw
    } else if has_jq {
        OutputMode::Jq
    } else {
        OutputMode::Pretty
    }
}

fn jsonl(entries: &[Value]) -> String {
    let lines: Vec<String> = entries.iter().map(Value::to_string).collect();
    format!("{}\n", lines.join("\n"))
}

fn write_entries(mode: OutputMode, entries: &[Value], out: &mut dyn Write) {
    match mode {
        OutputMode::Raw => {
            let _ = out.write_all(jsonl(entries).as_bytes());
        }
        OutputMode::Jq => {
            if !write_through_jq(entries) {
                write_entries(OutputMode::Pretty, entries, out);
            }
        }
        OutputMode::Pretty => {
            let blocks: Vec<String> = entries
                .iter()
                .map(|e| serde_json::to_string_pretty(e).unwrap_or_else(|_| e.to_string()))
                .collect();
            let _ = out.write_all(format!("{}\n", blocks.join("\n\n")).as_bytes());
        }
    }
}

/// Pipe the entries through `jq -C .` with stdout and stderr inherited.
/// False when jq could not be started.
fn write_through_jq(entries: &[Value]) -> bool {
    let Ok(mut child) = Command::new("jq")
        .args(["-C", "."])
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(jsonl(entries).as_bytes());
    }
    let _ = child.wait();
    true
}

pub fn run(args: &[String], ctx: &Context, out: &mut dyn Write) -> i32 {
    let parsed = match parse_log_args(args) {
        Ok(parsed) => parsed,
        Err(messages) => {
            for message in messages {
                chrome(&message, None);
            }
            return 1;
        }
    };
    let mode = output_mode(parsed.raw, ctx.stdout_is_tty, (ctx.which)("jq"));

    if parsed.n == Some(0) {
        return 0;
    }

    // A search scans every line; without one the count applies to raw lines.
    let line_limit = if parsed.search.is_some() {
        None
    } else {
        parsed.n
    };
    let LogRead { valid, corrupt } = read_log(ctx.home, line_limit);

    if valid.is_empty() && corrupt == 0 {
        chrome("No log entries yet.", None);
        return 0;
    }

    let mut results = match &parsed.search {
        Some(term) => search_entries(&valid, term),
        None => valid,
    };
    if parsed.search.is_some()
        && let Some(n) = parsed.n
    {
        let start = results.len().saturating_sub(n);
        results.drain(..start);
    }

    if results.is_empty() {
        chrome(
            if parsed.search.is_some() {
                "No matching log entries."
            } else {
                "No log entries yet."
            },
            None,
        );
        return 0;
    }

    write_entries(mode, &results, out);

    if corrupt > 0 {
        let noun = if corrupt == 1 { "entry" } else { "entries" };
        chrome(
            &format!("Warning: skipped {corrupt} corrupt log {noun}"),
            None,
        );
    }
    0
}
