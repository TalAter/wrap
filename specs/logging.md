# Wrap — Structured Logging

> Always-on invocation logging for debugging, observability, and future eval data.

## Why

When the LLM returns a malformed response, Wrap shows a terse error and exits. Without a log, the raw output is gone — debugging prompt issues, provider quirks, and schema mismatches is impossible without reproducing the failure. The same data also seeds future eval pipelines and thread history.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Always on | Yes | No opt-in flag. You shouldn't need to predict failures. |
| Storage | Single append-only JSONL | One file, one line per invocation. `tail`/`grep`/`jq` friendly. |
| Granularity | One record per invocation | A `rounds` array captures multi-step interactions. Written once at end. |
| Null fields | Omitted | Keeps the file compact. Absence = null. |
| Sensitive data | Logged verbatim | Same threat model as `~/.bash_history` — local file on user's machine. API keys redacted to last 4 chars. |
| System prompt | Hash only | Per-invocation context is full; the static prompt toolset is a SHA-256 hex for reproducibility without bloat. Match to prompt version in git. |
| Memory | Full snapshot | Entire `Memory` logged, not CWD-filtered. `cwd` is in the entry so the reader can reconstruct which scopes matched. Avoids duplicating filtering logic. |
| Timing | Per-round durations | `llm_ms`/`exec_ms` are `performance.now()` deltas, not absolute timestamps. Total derived by summing. |
| Round retries vs rounds | Nested | Transient parse-failure retries nest inside the round as `retry`. Non-final steps are separate rounds. Prevents conflating error recovery with conversation turns. |
| Threads / DSPy | Deferred | No `thread_id`; no automatic eval pipeline. Future cherry-pick workflow. |
| Privacy | User's responsibility | Documented — no redaction of prompts or responses. |

## Storage

Log file: `${WRAP_HOME}/logs/wrap.jsonl` (`WRAP_HOME` defaults to `~/.wrap`). The `logs/` dir is created on first write. Entries accumulate indefinitely — retention/pruning is future (see TODO).

## Log Entry Schema

Each line is one JSON object. **Fields with null/empty values are omitted.**

### Invocation-level

| Field | Type | Notes |
|---|---|---|
| `id` | string | `crypto.randomUUID()` — for future cherry-pick / thread references. |
| `timestamp` | string | ISO 8601 of invocation start. |
| `version` | string | Wrap version from `package.json`. |
| `prompt` | string | User's natural language input. |
| `cwd` | string | Working directory at invocation. |
| `piped_input` | string? | Piped stdin, truncated to first 1,000 chars with a `[…truncated, N chars total]` marker. Omitted if not piped. See `specs/piped-input.md`. |
| `memory` | object? | Full `Memory` (all scopes). Omitted if empty. |
| `provider` | object | Resolved provider snapshot. `apiKey` redacted to `...XXXX`. |
| `prompt_hash` | string | SHA-256 hex of the static prompt toolset — see below. |
| `rounds` | Round[] | One element per LLM call in the invocation. |
| `outcome` | enum | `success` \| `error` \| `blocked` \| `cancelled` \| `max_rounds`. Initialized to `error`; overwritten on success paths. |

### Round

| Field | Type | Notes |
|---|---|---|
| `raw_response` | string? | Verbatim LLM output. Omitted on successful parse (redundant with `parsed`) and when the provider failed before returning. |
| `parse_error` | string? | JSON/schema validation error. |
| `provider_error` | string? | Provider-level failure (subprocess crash, network, structured-output failure). |
| `parsed` | CommandResponse? | Parsed response object. |
| `execution` | Execution? | Omitted if no command was executed (answer, blocked, provider error). |
| `llm_ms` | number? | Wall-clock ms for the LLM call. |
| `exec_ms` | number? | Wall-clock ms for command execution. |
| `followup_text` | string? | Set only on the **first** round produced by a follow-up call, so the log can reconstruct which user message kicked off which sequence. Subsequent rounds in the same follow-up (e.g. step → command) leave it unset. The very first user turn of the entry lives on `LogEntry.prompt`, not here. |
| `retry` | object? | (TODO) First-attempt failure when a round retry occurred: `{raw_response, parse_error, llm_ms}`. |

### Execution

| Field | Type | Notes |
|---|---|---|
| `command` | string | Executed shell command. |
| `exit_code` | number | Process exit code. |
| `shell` | string | e.g. `/bin/zsh`. Same command can behave differently across shells. |

**Stdout/stderr are not captured.** Executed commands inherit the terminal's streams. Teeing would add complexity; the primary debugging value — the raw LLM response — doesn't require it.

## What Gets Logged

| Scenario | Logged? | Outcome |
|---|---|---|
| Successful command (exit 0) | Yes | `success` |
| Command non-zero exit | Yes | `error` |
| Answer | Yes | `success` |
| Empty `content` | Yes | `error` |
| Malformed JSON / structured-output failure | Yes — `provider_error` | `error` |
| Provider subprocess crashes | Yes — `provider_error` | `error` |
| Non-low-risk command, no TTY | Yes | `blocked` |
| Non-low-risk command, user cancels | Yes | `cancelled` |
| Non-final step | Yes — as a round with `execution` | — |
| Round budget exhausted | Yes | `max_rounds` |
| Provider init fails (e.g. unknown type) | No | — |
| No args / `--help` / `--version` / config errors | No | — |
| Round retry (future) | Nested in `round.retry`, not a separate round | — |

## Architecture

### Where logging hooks in

`runSession` (`src/session/session.ts`) owns the entry's lifecycle:

1. `createLogEntry(...)` at start — invocation-level fields populated.
2. Rounds appended via `addRound(entry, round)` from the runner's `onRound` callback; timing measured with `performance.now()` deltas.
3. `appendLogEntryIgnoreErrors(wrapHome, entry)` in a `finally` — writes regardless of outcome. **Logging failures are silently swallowed** (an unwritable log must never break the user's invocation).

### Prompt hash

Precomputed at DSPy optimization time and stored as `promptHash` in `src/prompt.optimized.json`. **Not recomputed at runtime.** It versions the static prompt toolset (generated artifacts + fixed fragments + conditionally-included static sections), not the invocation's exact rendered prompt.

### Reproducibility

Each entry captures everything needed to reconstruct an LLM call: `prompt`, `memory`, `cwd`, `provider`, `version`, `prompt_hash`, and (once wired) `tools_available`/`tools_unavailable`. `piped_input` rounds out the picture when present.

### stdout is sacred

Logging writes **only** to the filesystem. Never stdout, never stderr. Per the hard rule, Wrap's chrome never pollutes useful-output streams — and the log is not chrome, it's a side-effect.

## `--log` Subcommand

Implemented in `src/subcommands/log.ts`. See `specs/subcommands.md`. Output goes to **stdout** — it's useful output (log contents), not Wrap chrome.

```bash
w --log                  # all entries (pretty via jq if TTY, raw otherwise)
w --log 3                # last 3
w --log docker           # search
w --log docker 5         # search + limit
w --log --raw            # force raw JSONL
```

## Relationship to Other Systems

- **Verbose mode (`specs/verbose.md`):** Verbose is a curated, human-friendly **subset** of what the logger captures, rendered to stderr in real time. The log file is the source of truth for full diagnostic detail.
- **Threads (future):** Independent. Threads may reference entries by `id` or use their own storage — decided when built.
- **Eval / DSPy (future):** Logs are raw material. Manual cherry-pick into `eval/examples/seed.jsonl`. No automated pipeline.
- **Memory:** Snapshotted per entry. Updates from the LLM appear in `parsed.memory_updates`. Persistence lives separately at `~/.wrap/memory.json`.
- **Tool watchlist (see `specs/discovery.md`):** Once wired, `tools_available`/`tools_unavailable` capture the runtime probe results; per-round `watchlist_additions` track growth. Together they enable pruning — tools nominated long ago but never found/nominated again are candidates for removal.

## TODO

- [ ] `tools_available` / `tools_unavailable` invocation fields — `probeTools()` already returns structured data, needs wiring to the log entry.
- [ ] `watchlist_additions` round field — pass through from parsed LLM response.
- [ ] Round retry capture — nest first-attempt `{raw_response, parse_error, llm_ms}` inside `Round.retry`. Needs test provider changes.
- [ ] `cancelled` outcome — requires signal handling.
- [ ] `expires` field + retention pruning — computed as `timestamp + expiry duration` at write time; pruning deletes entries where `expires < now`.
- [ ] Document in help/README that logs contain full LLM exchanges (no redaction).
