---
name: logging
description: Always-on JSONL invocation logging — entry shape, round shape, lifecycle, --log subcommand
Source: src/logging/
Last-synced: c54a1a5
---

# Logging

Always-on, no opt-in. When the LLM returns malformed output, the raw response is gone without a log. Same data seeds future eval and thread history.

## Storage

`${WRAP_HOME}/logs/wrap.jsonl`. Single append-only file, one line per invocation. `tail`/`grep`/`jq` friendly.

## Entry shape

Invocation-level: `id` (UUID), `timestamp` (ISO 8601), `version`, `prompt`, `cwd`, `piped_input?` (truncated to 1000 chars), `memory?` (full snapshot, all scopes), `provider` (apiKey redacted to `...XXXX`), `prompt_hash` (SHA-256 of static prompt toolset, precomputed at optimization time), `rounds[]`, `outcome`.

Outcomes: `success`, `error`, `blocked`, `cancelled`, `max_rounds`. Initialized to `error`; overwritten on success paths.

Null/empty fields omitted — keeps file compact.

## Round shape

`attempts[]` is the canonical record — one Attempt per physical LLM call, up to four (initial → json-retry → scratchpad-retry → scratchpad's json-retry). Always length >= 1 once the round reaches the loggable state. `execution?` (`{command, exit_code, shell}`), `llm_ms?` (sum across attempts, kept for back-compat jq patterns), `exec_ms?`, `followup_text?`.

`followup_text` set only on the first round of a follow-up call. See [[follow-up]].

### Attempt shape

One Attempt carries `parsed?` (CommandResponse), `error?` (`{kind: "parse" | "provider" | "empty", message}`), `raw_response?` (always on parse failure, always on success when `logTraces` is on), `llm_ms?`, `wire_capture_error?` and — only when `logTraces` is on — `request?` (the PromptInput wrap built) plus `request_wire?` / `response_wire?` (provider-shaped bodies). Consumers that want the round's final parsed result read `round.attempts.at(-1)?.parsed`.

Stdout/stderr not captured — commands inherit the terminal's streams. Primary debug value is the raw LLM response.

## Detailed logging (`logTraces`)

Off by default. Toggle with `--log-traces` / `WRAP_LOG_TRACES=1` / `{"logTraces":true}`. When on, every attempt records the prompt and wire bodies. `request_wire.body` is the SDK-added delta (model, max_tokens, tools) — `system` and `messages` are stripped because they duplicate `attempt.request`. Headers are never logged. Subprocess env dict is never logged. A defensive apiKey scrub runs on every wire body before serialization. See [[session]] for how `llm-wire` notifications plumb from providers to `runRound`.

## Lifecycle

1. `createLogEntry(...)` at session start — invocation fields populated.
2. `addRound(entry, round)` from runner's callback. Timing via `performance.now()` deltas.
3. `appendLogEntryIgnoreErrors(wrapHome, entry)` in `finally` — writes regardless of outcome.

Prompt hash: precomputed in `src/prompt.optimized.json`, not recomputed at runtime. Versions the static prompt toolset for reproducibility.

## `--log` subcommand

Output to stdout (useful output, not chrome). See [[subcommands]].

```
w --log              # all entries, pretty
w --log 5            # last 5
w --log docker 3     # search + limit
w --log --raw        # force raw JSONL
```

Auto-detect: TTY + `jq` → `jq -C .`, TTY no `jq` → `JSON.stringify(_, null, 2)`, non-TTY → raw JSONL.

Missing log file → `No log entries yet.` on stderr, exit 0. Corrupt lines skipped with stderr warning.

## What gets logged

Successful commands, non-zero exits, answers, empty content, malformed JSON, provider crashes, blocked commands, cancelled commands, non-final steps, round budget exhaustion. Parse failures, provider errors, and empty-content responses surface as `attempt.error.kind` on the failing attempt. Memory-init LLM calls are NOT captured (separate lifecycle from the round loop). Provider init failures, `--help`/`--version`, config errors are NOT logged.

## Invariant

- **Logging failures are swallowed.** Broken log never crashes an invocation.

## Decisions

- **One record per invocation, `rounds` array inside.** Written once at end. Multi-step interactions captured without multiple appends.
- **Full memory snapshot per entry.** `cwd` in entry lets reader reconstruct scope matching. Avoids duplicating filtering logic.
- **System prompt as hash only.** Reproducibility without per-entry bloat. Match to prompt version in git.
- **Sensitive data logged verbatim.** Same threat model as `~/.bash_history` — local file. API keys redacted to last 4 chars.
