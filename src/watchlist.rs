//! The tool watchlist: names the model nominated for a `which` check on
//! every run, persisted in `tool-watchlist.json`.

use std::io;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::home::WrapHome;

const WATCHLIST_FILE: &str = "tool-watchlist.json";

// Entries come from user and model input and are interpolated into a shell
// `which` line, so only plain tool names may ever be persisted.
static VALID_TOOL_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$").expect("valid regex"));

pub fn is_valid_tool_name(name: &str) -> bool {
    VALID_TOOL_NAME.is_match(name)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchlistEntry {
    pub tool: String,
    /// `YYYY-MM-DD` of the latest nomination.
    pub added: String,
}

/// Entries on disk that are well-formed and carry a valid tool name. A
/// missing, empty, malformed or non-array file is an empty list.
pub fn load_watchlist(home: &WrapHome) -> Vec<WatchlistEntry> {
    let Ok(Some(raw)) = home.read(WATCHLIST_FILE) else {
        return Vec::new();
    };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(raw.trim())
    else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| serde_json::from_value::<WatchlistEntry>(item).ok())
        .filter(|entry| is_valid_tool_name(&entry.tool))
        .collect()
}

/// Nominate tools. New names are appended with today's date; re-nominated
/// names keep their position and get today's date. Invalid names are
/// dropped, and a batch with nothing valid touches nothing.
pub fn add_to_watchlist(home: &WrapHome, tools: &[String]) -> io::Result<()> {
    let valid: Vec<&String> = tools.iter().filter(|t| is_valid_tool_name(t)).collect();
    if valid.is_empty() {
        return Ok(());
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut entries = load_watchlist(home);
    for entry in &mut entries {
        if valid.iter().any(|t| **t == entry.tool) {
            entry.added = today.clone();
        }
    }
    for tool in valid {
        if !entries.iter().any(|e| e.tool == *tool) {
            entries.push(WatchlistEntry {
                tool: tool.clone(),
                added: today.clone(),
            });
        }
    }
    let json = serde_json::to_string_pretty(&entries).map_err(io::Error::other)?;
    home.write(WATCHLIST_FILE, &format!("{json}\n"))
}
