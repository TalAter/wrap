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

`raw_response?` (omitted on successful parse), `parse_error?`, `provider_error?`, `parsed?` (CommandResponse), `execution?` (`{command, exit_code, shell}`), `llm_ms?`, `exec_ms?`, `followup_text?`.

`followup_text` set only on the first round of a follow-up call. See [[follow-up]].

Stdout/stderr not captured — commands inherit the terminal's streams. Primary debug value is the raw LLM response.

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

Successful commands, non-zero exits, answers, empty content, malformed JSON, provider crashes, blocked commands, cancelled commands, non-final steps, round budget exhaustion. Provider init failures, `--help`/`--version`, config errors are NOT logged.

## Invariant

- **Logging failures are swallowed.** Broken log never crashes an invocation.

## Decisions

- **One record per invocation, `rounds` array inside.** Written once at end. Multi-step interactions captured without multiple appends.
- **Full memory snapshot per entry.** `cwd` in entry lets reader reconstruct scope matching. Avoids duplicating filtering logic.
- **System prompt as hash only.** Reproducibility without per-entry bloat. Match to prompt version in git.
- **Sensitive data logged verbatim.** Same threat model as `~/.bash_history` — local file. API keys redacted to last 4 chars.
