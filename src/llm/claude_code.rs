//! The `claude` CLI as a provider. The CLI has no multi-turn input format,
//! so the conversation flattens into one "User:"/"Assistant:" plaintext
//! prompt on stdin. It runs in the temp dir with session persistence off so
//! the user's cwd never leaks into the model's context.

use super::conversation::{LlmMessage, Role};
use super::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderResult};
use super::wires::{WireRequest, WireResponse};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

#[derive(Debug)]
pub(crate) struct ClaudeCodeProvider {
    model: Option<String>,
    /// `Err` when the environment has a PATH and the CLI is not on it.
    program: Result<PathBuf, String>,
    secrets: Vec<String>,
}

/// Flatten conversation messages into the single prompt the CLI reads.
pub fn flatten_messages(messages: &[LlmMessage]) -> String {
    messages
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
            };
            format!("{role}: {}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn build_argv(system: &str, model: Option<&str>, schema_json: &str) -> Vec<String> {
    let mut argv = vec![
        "claude".to_string(),
        "--tools".into(),
        String::new(),
        "--system-prompt".into(),
        system.to_string(),
    ];
    if let Some(model) = model {
        argv.push("--model".into());
        argv.push(model.to_string());
    }
    // --bare would skip config/MCP discovery but also skips credential
    // loading, so the CLI exits with "Not logged in".
    argv.extend([
        "--no-session-persistence".to_string(),
        "--json-schema".into(),
        schema_json.to_string(),
        "-p".into(),
    ]);
    argv
}

fn find_in_path(name: &str, path: Option<&String>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    path?.split(':').filter(|d| !d.is_empty()).find_map(|dir| {
        let candidate = Path::new(dir).join(name);
        let meta = std::fs::metadata(&candidate).ok()?;
        (meta.is_file() && meta.permissions().mode() & 0o111 != 0).then_some(candidate)
    })
}

impl ClaudeCodeProvider {
    pub fn new(
        model: Option<String>,
        api_key: Option<String>,
        env: &HashMap<String, String>,
    ) -> Self {
        Self {
            model,
            program: match (
                find_in_path("claude", env.get("PATH")),
                env.contains_key("PATH"),
            ) {
                (Some(path), _) => Ok(path),
                (None, false) => Ok("claude".into()),
                (None, true) => Err("cannot start claude: not found on PATH.".into()),
            },
            secrets: api_key.into_iter().collect(),
        }
    }

    pub fn secrets(&self) -> &[String] {
        &self.secrets
    }

    pub async fn call(&self, request: ProviderRequest<'_>) -> ProviderResult {
        let argv = build_argv(
            request.system,
            self.model.as_deref(),
            &request.schema.to_string(),
        );
        let stdin = flatten_messages(request.messages);
        let request_wire = Some(WireRequest::Subprocess {
            argv: argv.clone(),
            stdin: stdin.clone(),
        });
        let fail = |message: String, response_wire: Option<WireResponse>| {
            Box::new(ProviderError {
                message,
                request_wire: request_wire.clone(),
                response_wire,
            })
        };

        let program = self.program.as_ref().map_err(|m| fail(m.clone(), None))?;
        let mut child = tokio::process::Command::new(program)
            .args(&argv[1..])
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| fail(format!("cannot start claude: {e}"), None))?;
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| fail("cannot open claude stdin".into(), None))?;
        // Drain stdout/stderr concurrently with writing so a verbose CLI cannot deadlock.
        let write = async move {
            pipe.write_all(stdin.as_bytes()).await?;
            pipe.shutdown().await
        };
        let (written, output) = tokio::join!(write, child.wait_with_output());
        let output = output.map_err(|e| fail(e.to_string(), None))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let exit_code = output.status.code().unwrap_or(1);
        let response_wire = Some(WireResponse::Subprocess {
            stdout: stdout.clone(),
            stderr: (!stderr.is_empty()).then(|| stderr.clone()),
            exit_code,
        });
        if !output.status.success() {
            let trimmed = stderr.trim();
            let message = if trimmed.is_empty() {
                format!("claude exited with code {exit_code}.")
            } else {
                trimmed.to_string()
            };
            return Err(fail(message, response_wire));
        }
        written.map_err(|e| {
            fail(
                format!("cannot write claude stdin: {e}"),
                response_wire.clone(),
            )
        })?;
        Ok(ProviderReply {
            text: stdout.trim().to_string(),
            request_wire,
            response_wire,
        })
    }
}
