use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};
use wrap::home::WrapHome;
use wrap::llm::{Llm, LlmConfig, TestResponses};
use wrap::memory::{
    Fact, INIT_SYSTEM_PROMPT, InitError, InitSender, InitUi, Memory, MemoryUpdate, append_facts,
    count_facts, ensure_memory, ensure_memory_with_timeout, load_memory, run_probes, save_memory,
};
use wrap::paths::home_dir;

fn home() -> (tempfile::TempDir, WrapHome) {
    let dir = tempfile::tempdir().unwrap();
    let home = WrapHome::new(dir.path());
    (dir, home)
}

fn facts(items: &[&str]) -> Vec<Fact> {
    items
        .iter()
        .map(|f| Fact {
            fact: f.to_string(),
        })
        .collect()
}

fn memory(scopes: &[(&str, &[&str])]) -> Memory {
    scopes
        .iter()
        .map(|(scope, items)| (scope.to_string(), facts(items)))
        .collect()
}

fn update(fact: &str, scope: &str) -> MemoryUpdate {
    MemoryUpdate {
        fact: fact.into(),
        scope: scope.into(),
    }
}

fn tmp() -> String {
    fs::canonicalize("/tmp")
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

// --- load / save ----------------------------------------------------------

#[test]
fn load_returns_empty_when_missing_or_empty_object() {
    let (_dir, home) = home();
    assert_eq!(load_memory(&home).unwrap(), Memory::new());
    home.write("memory.json", "{}").unwrap();
    assert_eq!(load_memory(&home).unwrap(), Memory::new());
}

#[test]
fn load_parses_multiple_scopes_preserving_fact_order() {
    let (_dir, home) = home();
    home.write(
        "memory.json",
        r#"{"/":[{"fact":"Runs macOS on arm64"},{"fact":"Default shell is zsh"}],"/Users/tal/project":[{"fact":"Uses bun"}]}"#,
    )
    .unwrap();
    assert_eq!(
        load_memory(&home).unwrap(),
        memory(&[
            ("/", &["Runs macOS on arm64", "Default shell is zsh"]),
            ("/Users/tal/project", &["Uses bun"]),
        ])
    );
}

#[test]
fn broken_files_fail_with_the_memory_error_naming_the_file() {
    let (dir, home) = home();
    for broken in [
        "{ broken json",
        r#"[{"fact": "old format"}]"#,
        r#"{"/" : "not an array"}"#,
        "corrupt",
    ] {
        home.write("memory.json", broken).unwrap();
        let err = load_memory(&home).unwrap_err();
        assert!(err.starts_with("Memory error: "), "{err}");
        assert!(
            err.contains("memory.json is broken — delete the file and run Wrap again."),
            "{err}"
        );
        assert!(
            !err.contains(dir.path().to_str().unwrap()) || !dir.path().starts_with(home_dir()),
            "{err}"
        );
    }
}

#[test]
fn an_unreadable_memory_file_is_a_plain_memory_error() {
    // Root reads anything; the permission probe is meaningless there.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (dir, home) = home();
    home.write("memory.json", "{}").unwrap();
    let path = dir.path().join("memory.json");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    let err = load_memory(&home).unwrap_err();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        err,
        format!(
            "Memory error: {} could not be read — Permission denied.",
            wrap::paths::pretty_path(&path)
        )
    );
    assert!(!err.contains("os error"), "{err}");
}

#[test]
fn save_writes_sorted_two_space_json_and_overwrites() {
    let (_dir, home) = home();
    save_memory(&home, &memory(&[("/", &["old fact"])])).unwrap();
    save_memory(
        &home,
        &memory(&[
            ("/Users/tal/project", &["Uses bun"]),
            ("/", &["macOS", "second"]),
            ("/Users/tal/monorepo", &["Uses pnpm"]),
        ]),
    )
    .unwrap();
    let raw = fs::read_to_string(home.resolve("memory.json")).unwrap();
    assert_eq!(
        raw,
        "{\n  \"/\": [\n    {\n      \"fact\": \"macOS\"\n    },\n    {\n      \"fact\": \"second\"\n    }\n  ],\n  \"/Users/tal/monorepo\": [\n    {\n      \"fact\": \"Uses pnpm\"\n    }\n  ],\n  \"/Users/tal/project\": [\n    {\n      \"fact\": \"Uses bun\"\n    }\n  ]\n}"
    );
}

#[test]
fn count_facts_sums_all_scopes() {
    assert_eq!(
        count_facts(&memory(&[("/", &["a", "b"]), ("/x", &["c"])])),
        3
    );
    assert_eq!(count_facts(&Memory::new()), 0);
}

// --- append_facts ---------------------------------------------------------

#[test]
fn append_adds_to_existing_and_new_scopes_and_persists() {
    let (_dir, home) = home();
    save_memory(&home, &memory(&[("/", &["global"])])).unwrap();
    let result = append_facts(
        &home,
        &[update("new global", "/"), update("tmp fact", "/tmp")],
        std::path::Path::new("/"),
    )
    .unwrap();
    assert_eq!(result["/"], facts(&["global", "new global"]));
    assert_eq!(result[&tmp()], facts(&["tmp fact"]));
    assert_eq!(load_memory(&home).unwrap(), result);
    let keys: Vec<&String> = result.keys().collect();
    assert_eq!(keys[0], "/");
}

#[test]
fn append_drops_scopes_that_do_not_resolve_to_existing_dirs() {
    let (_dir, home) = home();
    save_memory(&home, &memory(&[("/", &["global"])])).unwrap();
    let result = append_facts(
        &home,
        &[
            update("discarded", "/nonexistent/path/xyz"),
            update("discarded", "~/nonexistent-dir-xyz"),
        ],
        std::path::Path::new("/"),
    )
    .unwrap();
    assert_eq!(result, memory(&[("/", &["global"])]));
}

#[test]
fn append_resolves_relative_and_tilde_scopes() {
    let (_dir, home) = home();
    let cwd = fs::canonicalize("/tmp").unwrap();
    let result = append_facts(&home, &[update("relative scope fact", ".")], &cwd).unwrap();
    assert_eq!(result[&tmp()], facts(&["relative scope fact"]));
    let result = append_facts(&home, &[update("home fact", "~")], &cwd).unwrap();
    let home_key = fs::canonicalize(home_dir())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(result[&home_key], facts(&["home fact"]));
}

#[test]
fn append_dedupes_within_a_scope_and_within_a_batch() {
    let (_dir, home) = home();
    save_memory(&home, &memory(&[("/", &["existing"])])).unwrap();
    let result = append_facts(
        &home,
        &[
            update("existing", "/"),
            update("same", "/"),
            update("same", "/"),
        ],
        std::path::Path::new("/"),
    )
    .unwrap();
    assert_eq!(result["/"], facts(&["existing", "same"]));
    let empty = append_facts(&home, &[], std::path::Path::new("/")).unwrap();
    assert_eq!(empty, memory(&[("/", &["existing", "same"])]));
}

#[test]
fn append_fails_on_a_broken_memory_file() {
    let (_dir, home) = home();
    home.write("memory.json", "corrupt").unwrap();
    let err = append_facts(&home, &[update("x", "/")], std::path::Path::new("/")).unwrap_err();
    assert!(err.starts_with("Memory error: "));
}

// --- probes ---------------------------------------------------------------

#[test]
fn run_probes_emits_a_labelled_section_per_probe() {
    let output = run_probes();
    assert!(output.starts_with("## OS\n"), "{output}");
    for label in ["## OS", "## Shell", "## Distro", "## Shell config files"] {
        assert!(output.contains(label), "{output}");
    }
    assert_eq!(
        output
            .split("\n\n")
            .filter(|s| s.starts_with("## "))
            .count(),
        4
    );
    assert!(!output.contains("\n\n\n"));
}

// --- ensure_memory --------------------------------------------------------

#[derive(Default)]
struct Ui {
    chrome: Mutex<Vec<(String, String)>>,
    verbose: Mutex<Vec<String>>,
}

impl InitUi for Ui {
    fn chrome(&self, text: &str, icon: &str) {
        self.chrome.lock().unwrap().push((text.into(), icon.into()));
    }
    fn verbose(&self, line: &str) {
        self.verbose.lock().unwrap().push(line.into());
    }
}

enum Reply {
    Facts(Vec<String>),
    Fail(InitError),
    Hang,
}

struct Sender {
    reply: Reply,
    calls: Mutex<Vec<(String, String)>>,
}

impl Sender {
    fn new(reply: Reply) -> Self {
        Sender {
            reply,
            calls: Mutex::new(Vec::new()),
        }
    }
    fn facts(items: &[&str]) -> Self {
        Self::new(Reply::Facts(items.iter().map(|s| s.to_string()).collect()))
    }
}

impl InitSender for Sender {
    fn label(&self) -> String {
        "test / (default)".into()
    }
    fn send_facts(
        &self,
        system: &str,
        user: &str,
    ) -> impl Future<Output = Result<Vec<String>, InitError>> {
        self.calls
            .lock()
            .unwrap()
            .push((system.into(), user.into()));
        async move {
            match &self.reply {
                Reply::Facts(f) => Ok(f.clone()),
                Reply::Fail(InitError::Aborted) => Err(InitError::Aborted),
                Reply::Fail(InitError::Other(m)) => Err(InitError::Other(m.clone())),
                Reply::Hang => std::future::pending().await,
            }
        }
    }
}

#[tokio::test]
async fn existing_memory_is_returned_without_contacting_the_llm() {
    let (_dir, home) = home();
    let existing = memory(&[("/", &["Runs macOS"])]);
    save_memory(&home, &existing).unwrap();
    let sender = Sender::new(Reply::Fail(InitError::Other("should not be called".into())));
    let ui = Ui::default();
    assert_eq!(ensure_memory(&home, &sender, &ui).await.unwrap(), existing);
    assert!(sender.calls.lock().unwrap().is_empty());
    assert!(ui.chrome.lock().unwrap().is_empty());
    assert_eq!(
        ui.verbose.lock().unwrap().as_slice(),
        ["Memory: 1 facts (1 global, 0 scoped)"]
    );
}

#[tokio::test]
async fn init_probes_sends_once_saves_under_root_and_announces() {
    let (_dir, home) = home();
    let sender = Sender::facts(&["  Runs macOS on arm64  ", "", "   ", "Default shell is zsh"]);
    let ui = Ui::default();
    let result = ensure_memory(&home, &sender, &ui).await.unwrap();
    assert_eq!(
        result,
        memory(&[("/", &["Runs macOS on arm64", "Default shell is zsh"])])
    );
    assert_eq!(load_memory(&home).unwrap(), result);

    let calls = sender.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, INIT_SYSTEM_PROMPT);
    assert!(calls[0].0.contains("system probe commands"));
    assert!(calls[0].1.contains("## OS"));
    assert!(calls[0].1.contains("## Shell"));
    assert_eq!(
        ui.chrome.lock().unwrap().as_slice(),
        [
            (
                "Learning about your system...".to_string(),
                "✨".to_string()
            ),
            ("Detected OS and shell".to_string(), "🧠".to_string()),
        ]
    );
}

#[tokio::test]
async fn second_run_loads_from_disk_instead_of_sending() {
    let (_dir, home) = home();
    ensure_memory(
        &home,
        &Sender::facts(&["Runs macOS on arm64"]),
        &Ui::default(),
    )
    .await
    .unwrap();
    let exploding = Sender::new(Reply::Fail(InitError::Other("boom".into())));
    let result = ensure_memory(&home, &exploding, &Ui::default())
        .await
        .unwrap();
    assert_eq!(result, memory(&[("/", &["Runs macOS on arm64"])]));
}

#[tokio::test]
async fn send_failure_is_prefixed_in_wraps_voice_and_nothing_is_saved() {
    let (_dir, home) = home();
    let sender = Sender::new(Reply::Fail(InitError::Other("network error".into())));
    let ui = Ui::default();
    let err = ensure_memory(&home, &sender, &ui).await.unwrap_err();
    assert_eq!(err, "LLM error (test / (default)): network error");
    assert!(!home.exists("memory.json"));
    let chrome = ui.chrome.lock().unwrap();
    assert_eq!(chrome.len(), 1);
    assert_eq!(chrome[0].0, "Learning about your system...");
}

#[tokio::test]
async fn abort_and_timeout_surface_as_a_plain_no_response_message() {
    let (_dir, home) = home();
    let aborted = Sender::new(Reply::Fail(InitError::Aborted));
    let err = ensure_memory(&home, &aborted, &Ui::default())
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "LLM error (test / (default)): no response after 120 seconds — check your internet connection and try again."
    );
    assert!(!home.exists("memory.json"));

    let hanging = Sender::new(Reply::Hang);
    let start = std::time::Instant::now();
    let err =
        ensure_memory_with_timeout(&home, &hanging, &Ui::default(), Duration::from_millis(50))
            .await
            .unwrap_err();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(
        err,
        "LLM error (test / (default)): no response after 0 seconds — check your internet connection and try again."
    );
    assert!(!home.exists("memory.json"));
}

#[tokio::test]
async fn empty_fact_list_still_counts_as_initialised() {
    let (_dir, home) = home();
    let result = ensure_memory(&home, &Sender::facts(&[]), &Ui::default())
        .await
        .unwrap();
    let expected: Memory = BTreeMap::from([("/".to_string(), Vec::new())]);
    assert_eq!(result, expected);
    assert_eq!(load_memory(&home).unwrap(), expected);
}

// --- ensure_memory over the real LLM layer (test provider) -----------------

fn test_llm(responses: Vec<Value>) -> Llm {
    Llm::new(
        LlmConfig::Test(TestResponses::List(responses)),
        &std::collections::HashMap::new(),
    )
    .unwrap()
}

#[tokio::test]
async fn llm_backed_init_saves_the_facts_the_model_returns() {
    let (_dir, home) = home();
    let llm = test_llm(vec![
        json!({"facts": ["Runs macOS on arm64", "Default shell is zsh"]}),
    ]);
    let result = ensure_memory(&home, &llm, &Ui::default()).await.unwrap();
    assert_eq!(
        result,
        memory(&[("/", &["Runs macOS on arm64", "Default shell is zsh"])])
    );
    assert_eq!(load_memory(&home).unwrap(), result);
}

#[tokio::test]
async fn llm_backed_init_recovers_through_the_parse_retry() {
    let (_dir, home) = home();
    let llm = test_llm(vec![json!("not json"), json!({"facts": ["x"]})]);
    let result = ensure_memory(&home, &llm, &Ui::default()).await.unwrap();
    assert_eq!(result, memory(&[("/", &["x"])]));
    assert!(home.exists("memory.json"));
}

#[tokio::test]
async fn llm_backed_init_fails_in_wraps_voice_when_both_attempts_are_unusable() {
    let (_dir, home) = home();
    let both_malformed = test_llm(vec![json!("not json"), json!("still not json")]);
    let err = ensure_memory(&home, &both_malformed, &Ui::default())
        .await
        .unwrap_err();
    assert!(err.starts_with("LLM error (test / (default)): "), "{err}");
    assert!(err.contains("JSON"), "{err}");
    assert!(!home.exists("memory.json"));

    let wrong_shape = test_llm(vec![json!({"wrong": "shape"}), json!({"wrong": "shape"})]);
    let err = ensure_memory(&home, &wrong_shape, &Ui::default())
        .await
        .unwrap_err();
    assert!(err.starts_with("LLM error (test / (default)): "), "{err}");
    assert!(err.contains("schema"), "{err}");
    assert!(!home.exists("memory.json"));

    let provider_failure = test_llm(vec![json!("ERROR: network error")]);
    let err = ensure_memory(&home, &provider_failure, &Ui::default())
        .await
        .unwrap_err();
    assert_eq!(err, "LLM error (test / (default)): network error");
    assert!(!home.exists("memory.json"));
}
