//! The models.dev catalog: the usable-model filter, the recommended-model
//! promotion, the 24h disk cache with stale fallback, and CLI probing.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use wrap::home::WrapHome;
use wrap::wizard::models_dev::{
    MODELS_CACHE_PATH, ModelEntry, apply_recommendation, fetch_models_at, filter_and_sort_models,
    on_path, probe_cli_binaries,
};

fn base(id: &str, date: &str) -> Value {
    json!({
        "id": id,
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "release_date": date,
    })
}

fn data() -> Value {
    let mut no_tools = base("claude-no-tools", "2026-03-02");
    no_tools["tool_call"] = json!(false);
    let mut deprecated = base("claude-deprecated", "2026-03-03");
    deprecated["status"] = json!("deprecated");
    let mut image_only = base("claude-image-only", "2024-01-01");
    image_only["modalities"] = json!({ "input": ["image"], "output": ["text"] });
    let mut no_text_out = base("claude-no-text-out", "2024-01-01");
    no_text_out["modalities"] = json!({ "input": ["text"], "output": ["audio"] });
    json!({
        "anthropic": { "id": "anthropic", "models": {
            "claude-sonnet-4-6": base("claude-sonnet-4-6", "2026-03-01"),
            "claude-sonnet-4-5": base("claude-sonnet-4-5", "2025-09-01"),
            "claude-haiku-4-5": base("claude-haiku-4-5", "2025-11-01"),
            "claude-opus-4-6": base("claude-opus-4-6", "2026-02-15"),
            "claude-no-tools": no_tools,
            "claude-deprecated": deprecated,
            "claude-image-only": image_only,
            "claude-no-text-out": no_text_out,
        }},
        "openai": { "id": "openai", "models": {
            "gpt-5": base("gpt-5", "2026-01-01"),
            "gpt-5.1": base("gpt-5.1", "2026-04-01"),
            "gpt-4o": base("gpt-4o", "2024-05-01"),
        }},
    })
}

fn ids(models: &[ModelEntry]) -> Vec<&str> {
    models.iter().map(|m| m.id.as_str()).collect()
}

#[test]
fn filter_drops_deprecated_non_tool_and_non_text_models_and_sorts_newest_first() {
    let result = filter_and_sort_models(&data(), "anthropic");
    assert_eq!(
        ids(&result),
        [
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-haiku-4-5",
            "claude-sonnet-4-5"
        ]
    );
    assert!(result.iter().all(|m| !m.recommended));
    assert_eq!(result[0].release_date, "2026-03-01");
}

#[test]
fn filter_returns_nothing_for_unknown_or_empty_providers() {
    assert!(filter_and_sort_models(&data(), "doesnotexist").is_empty());
    let empty = json!({ "foo": { "id": "foo", "models": {} } });
    assert!(filter_and_sort_models(&empty, "foo").is_empty());
    assert!(filter_and_sort_models(&json!("not an object"), "foo").is_empty());
}

#[test]
fn filter_tolerates_missing_fields() {
    let data = json!({ "test": { "id": "test", "models": {
        "no-modalities": { "id": "no-modalities", "tool_call": true, "release_date": "2026-01-01" },
        "no-tool-call": { "id": "no-tool-call", "modalities": { "input": ["text"], "output": ["text"] } },
        "tool-call-string": { "id": "tool-call-string", "tool_call": "true",
            "modalities": { "input": ["text"], "output": ["text"] } },
    }}});
    assert!(filter_and_sort_models(&data, "test").is_empty());
}

#[test]
fn undated_models_sort_after_dated_ones_and_use_the_key_when_id_is_missing() {
    let data = json!({ "test": { "id": "test", "models": {
        "undated": { "tool_call": true, "modalities": { "input": ["text"], "output": ["text"] } },
        "dated": { "id": "dated", "tool_call": true, "release_date": "2026-04-01",
            "modalities": { "input": ["text"], "output": ["text"] } },
    }}});
    let result = filter_and_sort_models(&data, "test");
    assert_eq!(ids(&result), ["dated", "undated"]);
    assert_eq!(result[1].release_date, "");
}

#[test]
fn recommendation_without_a_regex_or_match_leaves_the_list_alone() {
    let sorted = filter_and_sort_models(&data(), "anthropic");
    assert_eq!(apply_recommendation(sorted.clone(), None), sorted);
    let unmatched = apply_recommendation(sorted.clone(), Some("^gemini-"));
    assert_eq!(ids(&unmatched), ids(&sorted));
    assert!(unmatched.iter().all(|m| !m.recommended));
    assert!(apply_recommendation(Vec::new(), Some("^anything$")).is_empty());
}

#[test]
fn recommendation_promotes_the_newest_match_and_keeps_the_rest_in_order() {
    let sorted = filter_and_sort_models(&data(), "anthropic");
    let result = apply_recommendation(sorted.clone(), Some(r"^claude-opus-\d+-\d+$"));
    assert_eq!(
        ids(&result),
        [
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "claude-sonnet-4-5"
        ]
    );
    assert!(result[0].recommended);
    assert!(result[1..].iter().all(|m| !m.recommended));

    let result = apply_recommendation(sorted, Some(r"^claude-sonnet-\d+-\d+$"));
    assert_eq!(result[0].id, "claude-sonnet-4-6");
    assert!(result[0].recommended);
    let older = result.iter().find(|m| m.id == "claude-sonnet-4-5").unwrap();
    assert!(!older.recommended);
}

#[test]
fn invalid_regex_recommends_nothing() {
    let sorted = filter_and_sort_models(&data(), "openai");
    let result = apply_recommendation(sorted.clone(), Some("("));
    assert_eq!(result, sorted);
}

// ── CLI probing ─────────────────────────────────────────────────

#[test]
fn probe_reports_every_cli_provider_by_its_binary() {
    let present = probe_cli_binaries(|cmd| cmd == "claude");
    assert_eq!(present, BTreeMap::from([("claude-code".to_string(), true)]));
    let absent = probe_cli_binaries(|_| false);
    assert_eq!(absent, BTreeMap::from([("claude-code".to_string(), false)]));
}

#[test]
fn on_path_finds_executables_in_path_dirs_only() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("fakeclaude");
    std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(dir.path().join("notexec"), "").unwrap();
    let env = HashMap::from([("PATH".to_string(), dir.path().display().to_string())]);
    assert!(on_path(&env, "fakeclaude"));
    assert!(!on_path(&env, "notexec"));
    assert!(!on_path(&env, "missing"));
    assert!(!on_path(&HashMap::new(), "fakeclaude"));
}

// ── Cache + fetch ───────────────────────────────────────────────

fn fixture(providers: &[&str]) -> Value {
    let mut root = serde_json::Map::new();
    for p in providers {
        root.insert(
            (*p).into(),
            json!({ "id": p, "models": { format!("{p}-model"): base(&format!("{p}-model"), "2025-01-01") } }),
        );
    }
    Value::Object(root)
}

fn write_cache(home: &WrapHome, body: &str) -> SystemTime {
    home.write(MODELS_CACHE_PATH, body).unwrap();
    std::fs::metadata(home.resolve(MODELS_CACHE_PATH))
        .unwrap()
        .modified()
        .unwrap()
}

/// Serves `response` once and reports whether a request arrived.
fn http_fixture(response: Vec<u8>) -> (String, std::sync::mpsc::Receiver<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let _ = tx.send(());
        let mut request = [0; 2048];
        let _ = socket.read(&mut request);
        let _ = socket.write_all(&response);
    });
    (url, rx)
}

fn response(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn ok(body: &Value) -> Vec<u8> {
    response("200 OK", &body.to_string())
}

fn error_for(url: &str) -> String {
    format!(
        "Config error: could not load model list from {url}. Check your connection and try again."
    )
}

#[tokio::test]
async fn fresh_cache_is_served_without_touching_the_network() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let mtime = write_cache(&home, &fixture(&["cached"]).to_string());
    let (url, hit) = http_fixture(ok(&fixture(&["remote"])));
    let data = fetch_models_at(&home, &url, mtime + Duration::from_secs(23 * 3600))
        .await
        .unwrap();
    assert_eq!(data, fixture(&["cached"]));
    assert!(hit.try_recv().is_err(), "fresh cache must not fetch");
}

#[tokio::test]
async fn cache_miss_fetches_and_writes_the_cache_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let (url, hit) = http_fixture(ok(&fixture(&["remote"])));
    let data = fetch_models_at(&home, &url, SystemTime::now())
        .await
        .unwrap();
    assert!(hit.try_recv().is_ok());
    assert_eq!(data, fixture(&["remote"]));
    let cached: Value =
        serde_json::from_str(&home.read(MODELS_CACHE_PATH).unwrap().unwrap()).unwrap();
    assert_eq!(cached, fixture(&["remote"]));
}

#[tokio::test]
async fn stale_cache_is_refreshed_and_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let mtime = write_cache(&home, &fixture(&["stale"]).to_string());
    let (url, hit) = http_fixture(ok(&fixture(&["remote"])));
    let data = fetch_models_at(&home, &url, mtime + Duration::from_secs(25 * 3600))
        .await
        .unwrap();
    assert!(hit.try_recv().is_ok());
    assert_eq!(data, fixture(&["remote"]));
    let cached: Value =
        serde_json::from_str(&home.read(MODELS_CACHE_PATH).unwrap().unwrap()).unwrap();
    assert_eq!(cached, fixture(&["remote"]));
}

#[tokio::test]
async fn stale_cache_survives_a_failed_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let mtime = write_cache(&home, &fixture(&["stale"]).to_string());
    let later = mtime + Duration::from_secs(25 * 3600);
    let (not_found, _) = http_fixture(response("404 Not Found", "nope"));
    for url in ["http://127.0.0.1:1/".to_string(), not_found] {
        let data = fetch_models_at(&home, &url, later).await.unwrap();
        assert_eq!(data, fixture(&["stale"]), "{url}");
    }
    let cached: Value =
        serde_json::from_str(&home.read(MODELS_CACHE_PATH).unwrap().unwrap()).unwrap();
    assert_eq!(
        cached,
        fixture(&["stale"]),
        "a failed fetch keeps the cache"
    );
}

#[tokio::test]
async fn no_cache_and_a_failed_fetch_is_the_connection_error() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let url = "http://127.0.0.1:1/";
    let err = fetch_models_at(&home, url, SystemTime::now())
        .await
        .unwrap_err();
    assert_eq!(err, error_for(url));
    assert!(!home.exists(MODELS_CACHE_PATH));

    let (not_found, _) = http_fixture(response("404 Not Found", "nope"));
    let err = fetch_models_at(&home, &not_found, SystemTime::now())
        .await
        .unwrap_err();
    assert_eq!(err, error_for(&not_found));
    assert!(
        !home.exists(MODELS_CACHE_PATH),
        "a non-OK body is not cached"
    );
}

#[tokio::test]
async fn unparseable_bodies_are_errors_and_never_cached() {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    let (bad, _) = http_fixture(response("200 OK", "{{{"));
    let err = fetch_models_at(&home, &bad, SystemTime::now())
        .await
        .unwrap_err();
    assert_eq!(err, error_for(&bad));
    assert!(!home.exists(MODELS_CACHE_PATH));

    let mtime = write_cache(&home, "{{{ not json");
    let (url, _) = http_fixture(ok(&fixture(&["remote"])));
    let data = fetch_models_at(&home, &url, mtime + Duration::from_secs(60))
        .await
        .expect("a corrupt fresh cache is refetched");
    assert_eq!(data, fixture(&["remote"]));
}
