//! Runs the built `wrap` binary as a subprocess against an isolated
//! `WRAP_HOME`, the way the shell does. stdin is a pipe or `/dev/null`,
//! never a terminal, so every run exercises the non-interactive paths.
#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use tempfile::TempDir;

pub const MEMORY_SEED: &str = r#"{"/":[{"fact":"test"}]}"#;

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// One isolated installation: a fresh `WRAP_HOME`, a fresh `TMPDIR` so the
/// scratch dir and `--forget` cannot reach other tests, and the env the
/// binary sees. Reusable across runs so a continuation can chain.
pub struct Wrap {
    home: TempDir,
    tmp: TempDir,
    env: Vec<(String, String)>,
    stdin: Option<Vec<u8>>,
    cwd: Option<PathBuf>,
}

impl Wrap {
    /// A bare home: no memory, no config.
    pub fn bare() -> Self {
        Self {
            home: tempfile::tempdir().unwrap(),
            tmp: tempfile::tempdir().unwrap(),
            env: Vec::new(),
            stdin: None,
            cwd: None,
        }
    }

    /// Memory seeded (no init round) and an empty `WRAP_CONFIG`, so the test
    /// provider is reachable with a canned response.
    pub fn seeded() -> Self {
        let wrap = Self::bare();
        wrap.seed_memory();
        wrap.config(serde_json::json!({}))
    }

    pub fn seed_memory(&self) {
        std::fs::write(self.home.path().join("memory.json"), MEMORY_SEED).unwrap();
    }

    pub fn home(&self) -> &Path {
        self.home.path()
    }

    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.retain(|(k, _)| k != key);
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn config(self, config: Value) -> Self {
        self.env("WRAP_CONFIG", &config.to_string())
    }

    /// One canned response, replayed for every LLM call.
    pub fn response(self, response: Value) -> Self {
        self.env("WRAP_TEST_RESPONSE", &response.to_string())
    }

    /// Canned responses played one per LLM call.
    pub fn responses(self, responses: Vec<Value>) -> Self {
        self.env("WRAP_TEST_RESPONSES", &Value::Array(responses).to_string())
    }

    pub fn stdin(mut self, bytes: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(bytes.into());
        self
    }

    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    pub fn run(&self, args: &[&str]) -> Output {
        self.run_full(args, &[], None)
    }

    /// One run with canned responses that apply to this run only.
    pub fn run_with(&self, args: &[&str], responses: Vec<Value>) -> Output {
        let responses = Value::Array(responses).to_string();
        self.run_full(args, &[("WRAP_TEST_RESPONSES", &responses)], None)
    }

    /// One run with extra env entries layered over the installation's and,
    /// when `stdin` is given, that payload on a pipe instead of the default.
    pub fn run_full(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
        stdin: Option<&[u8]>,
    ) -> Output {
        let stdin = stdin.map(<[u8]>::to_vec).or_else(|| self.stdin.clone());
        let mut command = Command::new(env!("CARGO_BIN_EXE_wrap"));
        command.args(args);
        for key in [
            "WRAP_HOME",
            "WRAP_CONFIG",
            "WRAP_TEST_RESPONSE",
            "WRAP_TEST_RESPONSES",
            "WRAP_TEMP_DIR",
            "WRAP_THEME",
            "WRAP_MODEL",
            "WRAP_VERBOSE",
            "WRAP_YOLO",
            "WRAP_CONTINUE",
            "NO_COLOR",
            "FORCE_COLOR",
        ] {
            command.env_remove(key);
        }
        command
            .env("WRAP_HOME", self.home.path())
            .env("TMPDIR", self.tmp.path())
            .env("WRAP_THEME", "dark");
        for (key, value) in &self.env {
            command.env(key, value);
        }
        for (key, value) in extra_env {
            command.env(key, value);
        }
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        command
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("wrap binary spawns");
        if let Some(bytes) = stdin {
            let mut pipe = child.stdin.take().unwrap();
            pipe.write_all(&bytes).unwrap();
            drop(pipe);
        }
        let out = child.wait_with_output().unwrap();
        Output {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }

    /// Every entry in the log, oldest first.
    pub fn log_entries(&self) -> Vec<Value> {
        let path = self.home.path().join("logs/wrap.jsonl");
        let Ok(content) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        content
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// The single entry a one-shot run appended.
    pub fn log_entry(&self) -> Value {
        let mut entries = self.log_entries();
        assert_eq!(entries.len(), 1, "expected exactly one log entry");
        entries.remove(0)
    }
}

pub fn command(content: &str, risk: &str) -> Value {
    serde_json::json!({ "type": "command", "content": content, "risk_level": risk })
}

pub fn step(content: &str, explanation: &str) -> Value {
    serde_json::json!({
        "type": "command", "final": false, "content": content,
        "risk_level": "low", "explanation": explanation
    })
}

pub fn reply(content: &str) -> Value {
    serde_json::json!({ "type": "reply", "content": content, "risk_level": "low" })
}

/// The text of the first user turn (skill probe turns precede it).
pub fn first_user_text(entry: &Value) -> &str {
    entry["turns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["kind"] == "user")
        .and_then(|t| t["text"].as_str())
        .unwrap_or_default()
}

/// Kinds of the non-probe turns, the model trajectory of one entry.
pub fn turn_kinds(entry: &Value) -> Vec<String> {
    entry["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["kind"].as_str().unwrap().to_string())
        .filter(|k| k != "probe")
        .collect()
}
