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
| `expires` | string? | (Future) ISO 8601 timestamp after which this entry can be pruned. Omitted until expiry/pruning is implemented. |
| `prompt` | string | User's natural language input |
| `cwd` | string | Working directory at invocation time |
| `piped_input` | string? | Piped stdin content. Omitted if not piped. |
| `provider` | object | Provider config snapshot (e.g., `{"type": "claude-code", "model": "haiku"}`) |
| `prompt_hash` | string | SHA-256 hex digest of the system prompt components (see Prompt Hash Computation below) |
| `rounds` | array | Array of LLM round-trips (see below) |
| `outcome` | string | `"success"` \| `"error"` \| `"refused"` \| `"cancelled"` (future) \| `"max_rounds"` (future) |

### Round fields

Each element in `rounds`:

| Field | Type | Description |
|---|---|---|
| `raw_response` | string? | Verbatim string returned by the LLM. Omitted on successful parse (redundant with `parsed`) and when provider failed before returning. |
| `parse_error` | string? | Error message if JSON parsing or schema validation failed. Omitted on success. |
| `provider_error` | string? | Provider-level error (subprocess crash, network failure). Omitted on success. |
| `parsed` | object? | Parsed response object (matches `ResponseSchema`). Omitted if parsing failed. |
| `execution` | object? | Execution result (see below). Omitted if no command was executed. |

### Execution fields

| Field | Type | Description |
|---|---|---|
| `command` | string | The shell command that was executed |
| `exit_code` | number | Process exit code |

Note: stdout/stderr are not captured in v1. The executed command's output streams directly to the terminal (stdout inherits to stdout, stderr inherits to stderr). Capturing output while streaming would require teeing, which adds complexity. The primary debugging value — seeing the raw LLM response — doesn't require execution capture.

---

## Examples

### Successful command

```json
{"id":"a1b2c3d4-...","timestamp":"2026-03-21T14:30:00.123Z","prompt":"find all typescript files","cwd":"/Users/tal/projects","provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"command","command":"find . -name '*.ts'","risk_level":"low"},"execution":{"command":"find . -name '*.ts'","exit_code":0}}],"outcome":"success"}
```

### Parse failure (the primary debugging use case)

```json
{"id":"b2c3d4e5-...","timestamp":"2026-03-21T14:31:00.456Z","prompt":"list docker containers","cwd":"/Users/tal","provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"raw_response":"I'd be happy to help! Here's the command:\n```bash\ndocker ps\n```","parse_error":"LLM returned invalid JSON."}],"outcome":"error"}
```

### Provider failure

```json
{"id":"c3d4e5f6-...","timestamp":"2026-03-21T14:32:00.789Z","prompt":"show disk usage","cwd":"/Users/tal","provider":{"type":"claude-code"},"prompt_hash":"e3b0c44...","rounds":[{"provider_error":"claude: command not found"}],"outcome":"error"}
```

### Multi-round invocation (future: probe + command)

```json
{"id":"x9y8z7w6-...","timestamp":"2026-03-21T14:33:00.000Z","prompt":"add alias to shell config","cwd":"/Users/tal","provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"raw_response":"{\"type\":\"probe\",\"command\":\"echo $SHELL\",\"risk_level\":\"low\"}","parsed":{"type":"probe","command":"echo $SHELL","risk_level":"low"},"execution":{"command":"echo $SHELL","exit_code":0}},{"raw_response":"{\"type\":\"command\",\"command\":\"echo \\\"alias ll='ls -la'\\\" >> ~/.zshrc\",\"risk_level\":\"medium\"}","parsed":{"type":"command","command":"echo \"alias ll='ls -la'\" >> ~/.zshrc","risk_level":"medium"}}],"outcome":"success"}
```

Note: retry attempts after JSON parse failure (SPEC.md section 8.2) are logged as separate rounds. Both the failed parse and the retry appear in the `rounds` array.

---

## What Gets Logged

| Scenario | Logged? | Outcome |
|---|---|---|
| Successful command execution (exit 0) | Yes | `"success"` |
| Command execution with non-zero exit | Yes | `"error"` |
| LLM returns answer | Yes | `"success"` |
| LLM returns malformed JSON | Yes — `raw_response` captures the garbage, `parse_error` explains why | `"error"` |
| LLM response fails schema validation | Yes — `raw_response` has the valid JSON that didn't match the schema | `"error"` |
| Provider subprocess crashes | Yes — `provider_error` captures the failure | `"error"` |
| Non-low risk command (confirmation needed) | Yes | `"refused"` |
| Probe (not yet supported) | Yes | `"refused"` |
| Provider initialization fails (e.g., unknown type) | No | — |
| No args / help screen | No | — |
| Config errors | No | — |
| Probe round (future) | Yes — as a round in the same entry | |
| Error retry (future) | Yes — as additional rounds | |

---

## `wrap log` Subcommand (Future)

Spec'd but not implemented in this phase.

```bash
wrap log          # Pretty-print last log entry (to stdout)
wrap log 3        # Pretty-print last 3 entries
wrap log --all    # Dump all entries
```

Output goes to stdout (it's useful output, not Wrap chrome). Displayed as colorized, indented JSON.

**Future idea:** the default output could also be raw (one entry per line, no indentation) for piping into tools like [Television](https://github.com/alexpasmantier/television) for interactive browsing and filtering.

---

## Implementation Notes

### Where logging hooks in

Logging wraps the query loop. The `runQuery` function builds up a log entry as it runs:

1. **Entry created** at start of `runQuery` with invocation-level fields (prompt, cwd, provider, prompt_hash)
2. **Round appended** after each LLM call — captures raw response, parse result, and execution
3. **Entry written** to JSONL at the end of `runQuery`, regardless of success/failure

### Prompt hash computation

The prompt hash is precomputed at DSPy optimization time and exported as `PROMPT_HASH` from `src/prompt.optimized.ts`. It is **not** recomputed at runtime — the optimizer writes it once when generating the file.

The hash is the SHA-256 hex digest of the concatenation of all prompt components:

```
sha256(systemPrompt + "\n" + schemaText + "\n" + JSON.stringify(fewShotDemos))
```

Missing components use stable fallbacks (empty string for text, `[]` for demos) so the hash is always deterministic. The Python optimizer (`eval/dspy/optimize.py`) uses `json.dumps(demos, separators=(',', ':'))` to match JS `JSON.stringify()`'s compact output.

### stdout is sacred

All logging writes to the filesystem only. No logging output goes to stdout or stderr during normal operation.

### Testing

Integration tests already set `WRAP_HOME` to a temp directory, so log files land there naturally. Tests should assert on log file contents — verify the entry exists, check field values, confirm the schema shape. No need to mock the logging layer; test it end-to-end.

---

## To-do

- [ ] `piped_input` — detect piped stdin in `parseInput` and pass through to log entry
- [ ] `wrap log` subcommand — pretty-print recent log entries (see spec above)
- [ ] `expires` field + retention pruning — write expiry timestamp, prune old entries
- [ ] `cancelled` outcome — when user cancels mid-invocation (requires signal handling)
- [ ] `max_rounds` outcome — when multi-round loop hits its limit (requires probe/retry loop)
- [ ] Multi-round logging — probe + retry rounds accumulate in the same entry
- [ ] Document in help/README that logs contain full LLM exchanges

---

## Relationship to Other Systems

- **Threads (future):** Logging and threads are independent. Threads may reference log entries by ID in the future, or maintain their own storage. Decided when threads are built.
- **Eval / DSPy (future):** Logs serve as raw material for training data. A future `wrap log export` command or manual cherry-pick workflow transforms log entries into `eval/examples/seed.jsonl` format. No automated pipeline.
- **Memory (future):** Memory updates from `parsed.memory_updates` are visible in log entries but memory persistence is a separate system.

---

## To Do

- [ ] Log module (`src/logging/`) — create log entry, append rounds, write JSONL
- [ ] Log entry creation at start of `runQuery` with invocation-level fields
- [ ] Round appending after each LLM call (raw_response, parse_error/provider_error, parsed, execution)
- [ ] JSONL writing to `~/.wrap/logs/wrap.jsonl` at end of `runQuery`
- [ ] Prompt hash computation (SHA-256 of system prompt + schema + demos)
- [ ] Lazy `logs/` directory creation on first write
- [ ] Omit null fields from JSON output
- [ ] Tests — assert on log file contents in integration tests (WRAP_HOME already isolated)
- [ ] `wrap log` subcommand — pretty-print last N entries (deferred, spec'd in §"wrap log Subcommand")
