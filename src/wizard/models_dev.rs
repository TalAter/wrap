//! The models.dev catalog the wizard offers per provider: the usable-model
//! filter, the recommended-model promotion, a 24h disk cache with stale
//! fallback, and the CLI-binary probe.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::config::providers::CLI_PROVIDERS;
use crate::home::WrapHome;

pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";
/// Relative to `$WRAP_HOME`.
pub const MODELS_CACHE_PATH: &str = "cache/models.dev.json";
pub const MODELS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// The raw `api.json` document: providers keyed by id, each with a `models`
/// map. Only the fields the filter reads are interpreted.
pub type ModelsDevData = Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelEntry {
    pub id: String,
    /// Empty when the catalog has no date.
    pub release_date: String,
    pub recommended: bool,
}

fn has_text(model: &Value, direction: &str) -> bool {
    model["modalities"][direction]
        .as_array()
        .is_some_and(|list| list.iter().any(|v| v == "text"))
}

/// Chat models usable by Wrap: tool-calling, not deprecated, text in and
/// text out. Newest first; undated models last, ties in catalog order.
pub fn filter_and_sort_models(data: &ModelsDevData, provider_id: &str) -> Vec<ModelEntry> {
    let Some(models) = data[provider_id]["models"].as_object() else {
        return Vec::new();
    };
    let mut entries: Vec<ModelEntry> = models
        .iter()
        .filter(|(_, m)| {
            m["tool_call"] == Value::Bool(true)
                && m["status"].as_str() != Some("deprecated")
                && has_text(m, "input")
                && has_text(m, "output")
        })
        .map(|(key, m)| ModelEntry {
            id: m["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .unwrap_or(key)
                .to_string(),
            release_date: m["release_date"].as_str().unwrap_or("").to_string(),
            recommended: false,
        })
        .collect();
    entries.sort_by(|a, b| b.release_date.cmp(&a.release_date));
    entries
}

/// Promotes the newest model matching `regex` to the top and stars it.
/// Input is newest-first, so the first match is the newest.
pub fn apply_recommendation(models: Vec<ModelEntry>, regex: Option<&str>) -> Vec<ModelEntry> {
    let Some(re) = regex.and_then(|source| regex::Regex::new(source).ok()) else {
        return models;
    };
    let Some(pos) = models.iter().position(|m| re.is_match(&m.id)) else {
        return models;
    };
    let mut models = models;
    let mut pick = models.remove(pos);
    pick.recommended = true;
    models.insert(0, pick);
    models
}

/// The plain-language failure for a catalog that could not be loaded.
pub fn models_error(url: &str) -> String {
    format!(
        "Config error: could not load model list from {url}. Check your connection and try again."
    )
}

/// The catalog from the cache when it is younger than the TTL, else from
/// `url` (written to the cache on success). A failed fetch serves any cached
/// copy, however old; with no cache it is the connection error.
pub async fn fetch_models(home: &WrapHome, url: &str) -> Result<ModelsDevData, String> {
    fetch_models_at(home, url, SystemTime::now()).await
}

/// [`fetch_models`] with `now` as the clock judging cache freshness.
pub async fn fetch_models_at(
    home: &WrapHome,
    url: &str,
    now: SystemTime,
) -> Result<ModelsDevData, String> {
    let cached = home.read(MODELS_CACHE_PATH).ok().flatten();
    if let Some(content) = &cached
        && is_fresh(&home.resolve(MODELS_CACHE_PATH), now)
        && let Ok(data) = serde_json::from_str(content)
    {
        return Ok(data);
    }
    if let Ok(body) = fetch(url).await
        && let Ok(data) = serde_json::from_str::<Value>(&body)
    {
        let _ = home.write(MODELS_CACHE_PATH, &body);
        return Ok(data);
    }
    cached
        .and_then(|content| serde_json::from_str(&content).ok())
        .ok_or_else(|| models_error(url))
}

fn is_fresh(path: &Path, now: SystemTime) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|mtime| now.duration_since(mtime).ok())
        .is_some_and(|age| age < MODELS_TTL)
}

async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    let client = reqwest::Client::builder().timeout(FETCH_TIMEOUT).build()?;
    client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await
}

/// Which CLI providers have their binary available, by provider name.
pub fn probe_cli_binaries(which: impl Fn(&str) -> bool) -> BTreeMap<String, bool> {
    CLI_PROVIDERS
        .iter()
        .map(|p| (p.name.to_string(), which(p.probe_cmd)))
        .collect()
}

/// Whether `cmd` is an executable file in one of `PATH`'s directories.
pub fn on_path(env: &HashMap<String, String>, cmd: &str) -> bool {
    let Some(path) = env.get("PATH") else {
        return false;
    };
    std::env::split_paths(path).any(|dir| is_executable(&dir.join(cmd)))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}
