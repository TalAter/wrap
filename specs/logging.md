# Wrap — Structured Logging

> Always-on invocation logging for debugging, observability, and future eval/training data.

---

## Motivation

When the LLM returns a malformed response (invalid JSON, schema mismatch), Wrap shows a terse error and exits. The raw LLM output is discarded — there's no way to inspect what actually came back. This makes debugging prompt issues, provider quirks, and schema mismatches impossible without reproducing the failure.

Logging solves this by capturing every LLM interaction to disk as it happens. The same data also serves as the foundation for future eval pipelines (DSPy cherry-picking) and thread/session history.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Always on | Yes | No `--verbose` or opt-in flag. Every invocation logs. You shouldn't need to predict failures. |
| Storage format | Single append-only JSONL file | One file, one line per invocation. Simple to tail, grep, parse. |
| Granularity | One record per invocation | A `rounds` array captures multi-step interactions (probes, retries). Written once at end of invocation. |
| Null fields | Omitted | Fields with null values are omitted from the JSON to keep the file compact. Absence = null. |
| Sensitive data | Logged verbatim | Piped stdin, prompts, raw responses — all logged as-is. Same threat model as `~/.bash_history`. Local file on user's machine. |
| System prompt | Hash only | Per-invocation context (user prompt, cwd, piped input) is logged in full. System prompt + schema + demos are represented by a SHA-256 hash for reproducibility without bloat. Match hash to prompt version in git. |
| Memory | Full snapshot | The entire `Memory` object is logged, not just CWD-filtered facts. CWD is in the entry, so the reader can reconstruct which scopes matched. Logging full memory avoids duplicating the filtering logic and provides more context. |
| Timing | Per-round durations | `llm_ms` and `exec_ms` are stored as `performance.now()` deltas on each round, not as absolute timestamps. Keeps the data simple; total time can be derived by summing. |
| Retries vs rounds | Nested, not flat | Structured-output retries (transient JSON parse failures) are nested inside the round as a `retry` field. Real multi-turn interactions (probes) are separate rounds. This prevents conflating error recovery with meaningful conversation turns. |
| Thread coupling | None (deferred) | No `thread_id` in log entries. Thread system will decide its own storage strategy when built. |
| DSPy integration | Manual cherry-pick (future) | Logs are not automatically piped to DSPy. Future workflow: inspect logs, select interesting entries, manually reshape into eval examples. |
| Privacy | User's responsibility | Document in help/README that logs contain full LLM exchanges. No redaction. |

---

## Log Location

```
~/.wrap/logs/wrap.jsonl
```

Directory is relative to `WRAP_HOME` (defaults to `~/.wrap`). The `logs/` directory is created on first write.

**Retention (future):** log entries may optionally include an `expires` timestamp (ISO 8601), computed as `timestamp + expiry duration` at write time. Pruning (deleting entries where `expires < now`) and the expiry duration itself are future features — not implemented yet. Until then, entries are written without `expires` and logs accumulate indefinitely.

---

## Log Entry Schema

Each line in `wrap.jsonl` is a single JSON object. **Fields with null values are omitted** — if a field isn't present, treat it as null/absent.

### Invocation-level fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique invocation ID (`crypto.randomUUID()`). For future use: cherry-pick workflow, thread references. |
| `timestamp` | string | ISO 8601 timestamp of invocation start |
| `version` | string | Wrap version from package.json (e.g., `"0.1.0"`) |
| `expires` | string? | (Future) ISO 8601 timestamp after which this entry can be pruned. Omitted until expiry/pruning is implemented. |
| `prompt` | string | User's natural language input |
| `cwd` | string | Working directory at invocation time |
| `piped_input` | string? | Piped stdin content. Omitted if not piped. (Piping not yet implemented — field exists for when it is.) |
| `memory` | object? | Memory state at invocation time — full `Memory` object (all scopes). Omitted if empty. CWD-filtered subset can be reconstructed from `cwd` field. |
| `provider` | object | Provider config snapshot (e.g., `{"type": "claude-code", "model": "haiku"}`). API keys redacted to last 4 chars. |
| `prompt_hash` | string | SHA-256 hex digest of the system prompt components (see Prompt Hash Computation below) |
| `rounds` | array | Array of LLM round-trips (see below) |
| `outcome` | string | `"success"` \| `"error"` \| `"refused"` \| `"cancelled"` (future) \| `"max_rounds"` (future) |

### Round fields

Each element in `rounds`:

| Field | Type | Description |
|---|---|---|
| `raw_response` | string? | Verbatim string returned by the LLM. Omitted on successful parse (redundant with `parsed`) and when provider failed before returning. |
| `parse_error` | string? | Error message if JSON parsing or schema validation failed. Omitted on success. |
| `provider_error` | string? | Provider-level error (subprocess crash, network failure, structured output failure). Omitted on success. |
| `parsed` | object? | Parsed `CommandResponse` object. Omitted if parsing failed. |
| `execution` | object? | Execution result (see below). Omitted if no command was executed. |
| `llm_ms` | number? | Wall-clock milliseconds for the LLM call (includes retry time if applicable). |
| `exec_ms` | number? | Wall-clock milliseconds for command execution. Omitted if no command was executed. |
| `retry` | object? | (Not yet implemented) First-attempt failure when structured output retry occurred. Contains `raw_response`, `parse_error`, and `llm_ms` from the failed attempt. Omitted when no retry happened. |

### Execution fields

| Field | Type | Description |
|---|---|---|
| `command` | string | The shell command that was executed |
| `exit_code` | number | Process exit code |
| `shell` | string | Shell used to execute the command (e.g., `/bin/zsh`, `/bin/bash`). Same command can behave differently across shells. |

Note: stdout/stderr are not captured. The executed command's output streams directly to the terminal (stdout/stderr inherit). Capturing output while streaming would require teeing, which adds complexity. The primary debugging value — seeing the raw LLM response — doesn't require execution capture.

---

## Examples

### Successful command

```json
{"id":"a1b2c3d4-...","timestamp":"2026-03-21T14:30:00.123Z","version":"0.1.0","prompt":"find all typescript files","cwd":"/Users/tal/projects","memory":{"/":[{"fact":"macOS 14.6, Apple Silicon (arm64)"},{"fact":"zsh"}],"/Users/tal/projects":[{"fact":"uses bun"}]},"provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"command","content":"find . -name '*.ts'","risk_level":"low"},"execution":{"command":"find . -name '*.ts'","exit_code":0,"shell":"/bin/zsh"},"llm_ms":820,"exec_ms":45}],"outcome":"success"}
```

### Parse failure (the primary debugging use case)

```json
{"id":"b2c3d4e5-...","timestamp":"2026-03-21T14:31:00.456Z","version":"0.1.0","prompt":"list docker containers","cwd":"/Users/tal","memory":{"/":[{"fact":"macOS 14.6"}]},"provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"provider_error":"No object generated: could not parse output as JSON.","llm_ms":650}],"outcome":"error"}
```

### Provider failure

```json
{"id":"c3d4e5f6-...","timestamp":"2026-03-21T14:32:00.789Z","version":"0.1.0","prompt":"show disk usage","cwd":"/Users/tal","provider":{"type":"claude-code"},"prompt_hash":"e3b0c44...","rounds":[{"provider_error":"claude: command not found","llm_ms":12}],"outcome":"error"}
```

### Multi-round invocation (future: probe + command)

```json
{"id":"x9y8z7w6-...","timestamp":"2026-03-21T14:33:00.000Z","version":"0.1.0","prompt":"add alias to shell config","cwd":"/Users/tal","memory":{"/":[{"fact":"macOS 14.6"}]},"provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"probe","content":"echo $SHELL","risk_level":"low"},"execution":{"command":"echo $SHELL","exit_code":0,"shell":"/bin/zsh"},"llm_ms":400,"exec_ms":5},{"parsed":{"type":"command","content":"echo \"alias ll='ls -la'\" >> ~/.zshrc","risk_level":"medium"},"llm_ms":500}],"outcome":"success"}
```

---

## What Gets Logged

| Scenario | Logged? | Outcome |
|---|---|---|
| Successful command execution (exit 0) | Yes | `"success"` |
| Command execution with non-zero exit | Yes | `"error"` |
| LLM returns answer | Yes | `"success"` |
| LLM returns malformed JSON / structured output failure | Yes — `provider_error` captures the failure | `"error"` |
| Provider subprocess crashes | Yes — `provider_error` captures the failure | `"error"` |
| Non-low risk command (confirmation needed) | Yes | `"refused"` |
| Probe (not yet supported) | Yes | `"refused"` |
| Provider initialization fails (e.g., unknown type) | No | — |
| No args / help screen | No | — |
| Config errors | No | — |
| Probe round (future) | Yes — as a round in the same entry | |
| Error retry (future) | Yes — nested in `round.retry`, not a separate round | |

---

## `--log` Subcommand

Implemented in `src/subcommands/log.ts`. See `specs/subcommands.md` for full behavior spec.

```bash
w --log                  # all entries (raw JSONL, or pretty-printed via jq if TTY)
w --log 3                # last 3 entries
w --log docker           # search entries for "docker"
w --log docker 5         # search + limit
w --log --raw            # force raw JSONL (no jq)
```

Output goes to stdout (it's useful output, not Wrap chrome).

---

## Architecture

### Where logging hooks in

Logging wraps the query loop in `runQuery` (`src/core/query.ts`):

1. **Entry created** at start with invocation-level fields (prompt, cwd, memory, version, provider, prompt_hash)
2. **Round populated** during LLM call and execution — timing via `performance.now()` deltas
3. **Entry written** to JSONL in a `finally` block, regardless of success/failure. Logging failures are silently swallowed.

### Prompt hash computation

The prompt hash is precomputed at DSPy optimization time and exported as `PROMPT_HASH` from `src/prompt.optimized.ts`. It is **not** recomputed at runtime — the optimizer writes it once when generating the file.

The hash is the SHA-256 hex digest of the concatenation of all prompt components:

```
sha256(systemPrompt + "\n" + schemaText + "\n" + JSON.stringify(fewShotDemos))
```

Missing components use stable fallbacks (empty string for text, `[]` for demos) so the hash is always deterministic. The Python optimizer (`eval/dspy/optimize.py`) uses `json.dumps(demos, separators=(',', ':'))` to match JS `JSON.stringify()`'s compact output.

### Reproducibility

A log entry captures everything needed to reproduce an LLM call:
- **Prompt** — user's input
- **Memory** — full fact state at invocation time (CWD determines which scopes the LLM saw)
- **Prompt hash** — identifies the exact system prompt / schema / demos version
- **Provider** — which model was called
- **Version** — which Wrap release was running

The only missing piece is `piped_input`, which isn't captured yet because piping isn't implemented.

### stdout is sacred

All logging writes to the filesystem only. No logging output goes to stdout or stderr during normal operation.

---

## Relationship to Other Systems

- **Threads (future):** Logging and threads are independent. Threads may reference log entries by ID in the future, or maintain their own storage. Decided when threads are built.
- **Eval / DSPy (future):** Logs serve as raw material for training data. A future `wrap log export` command or manual cherry-pick workflow transforms log entries into `eval/examples/seed.jsonl` format. No automated pipeline.
- **Memory:** Memory state is snapshotted in each log entry. Memory updates from the LLM response are visible in `parsed.memory_updates`. Memory persistence is a separate system (`~/.wrap/memory.json`).

---

## TODO

- [ ] Retry capture — nest first-attempt `raw_response`/`parse_error`/`llm_ms` inside `Round.retry` (design agreed, needs test provider changes to test the retry path)
- [ ] `piped_input` field — thread through from `parseInput` to both log entry and `assembleCommandPrompt` (blocked on piping support)
- [ ] `cancelled` outcome (requires signal handling)
- [ ] `max_rounds` outcome (requires probe/retry loop)
- [ ] `expires` field + retention pruning
- [ ] Document in help/README that logs contain full LLM exchanges
