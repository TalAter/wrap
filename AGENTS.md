# Wrap

Rust CLI that turns natural language into a shell command, confirms it in a
custom Ratatui dialog when it carries risk, and runs it. Prefer established,
maintained crates; keep project-specific behavior in this repository.

Read [testing.md](testing.md) before writing tests or implementation. Work
test-first and make **green atomic commits**: one coherent purpose, relevant
checks passing, and a concise commit message explaining why.

Preserve CLI behavior, terminal quality, configuration, and persisted data.
Read [architecture](docs/architecture.md) for non-obvious contracts and
[GLOSSARY.md](GLOSSARY.md) for domain vocabulary. Keep docs concise and current.

Hard rules:

- stdout carries only useful output (command output, answer text, the payload
  of `--help`/`--log`/`--version`/`--completion`). All chrome goes to stderr.
- User-facing errors are plain language with one prefix per category
  (`Config error:`, `LLM error (…):`, `Memory error:`, …). No internals.
- Prompt text lives in `src/prompt/`; see the architecture note before editing.

Use Cargo for dependencies and workflows. Follow [testing.md](testing.md) to
choose checks for each change before committing. Verify terminal interactions
when UI behavior changes. Git hooks do not run these checks automatically.

`~/.wrap/config.jsonc` (or `$WRAP_HOME/config.jsonc`) contains live provider
keys. Never print credentials. Tests use disposable homes, never the live home.
Keep responses concise.
