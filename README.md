# Wrap

Translate a request into a shell command, review it, and run it. Wrap can also
answer questions, inspect intermediate results, and continue earlier sessions.

```sh
cargo build --locked --release --bin wrap
./target/release/wrap --help
./target/release/wrap find files modified today
```

Interactive setup configures a provider on first use. Configuration lives in
`$WRAP_HOME/config.jsonc` (default `~/.wrap`); `WRAP_CONFIG` supplies a shallow
JSON override. Run `wrap --help` for options, completion, history, and forgetting.

API providers: Anthropic, OpenAI, OpenRouter, Groq, Mistral, Ollama, and custom
OpenAI-compatible endpoints. Claude Code uses its installed CLI and credentials.

`make check terminal` runs formatting, Clippy, behavioral tests, public CLI
contracts, and real PTY checks. `make linux-test` runs the behavioral and terminal
checks in a disposable Linux container. See [testing.md](testing.md),
[architecture](docs/architecture.md), and [GLOSSARY.md](GLOSSARY.md) for
development contracts.
