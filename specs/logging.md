# Wrap — Structured Logging

> Always-on invocation logging for debugging, observability, and future eval/training data.

> **Status:** Implemented — core logging works. See `specs/todo.md` for remaining gaps.

---

## Motivation

When the LLM returns a malformed response (invalid JSON, schema mismatch), Wrap shows a terse error and exits. The raw LLM output is discarded — there's no way to inspect what actually came back. Logging captures every LLM interaction to disk as it happens. The same data serves as the foundation for future eval pipelines and thread/session history.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Always on | Yes | No `--verbose` or opt-in flag. Every invocation logs. You shouldn't need to predict failures. |
| Storage format | Single append-only JSONL file | One file, one line per invocation. Simple to tail, grep, parse. |
| Granularity | One record per invocation | A `rounds` array captures multi-step interactions (probes, retries). Written once at end of invocation. |
| Null fields | Omitted | Fields with undefined values are omitted from JSON. Absence = null. |
| Sensitive data | Logged verbatim | Piped stdin, prompts, raw responses — all logged as-is. Same threat model as `~/.bash_history`. Local file on user's machine. Document in help/README. |
| Execution output | Not captured | Command stdout/stderr streams directly to the terminal (inherited). Capturing while streaming would require teeing. The primary debugging value — raw LLM responses — doesn't need execution capture. |
| System prompt | Hash only | System prompt + schema + demos represented by a SHA-256 hash for reproducibility without bloat. Match hash to prompt version in git. |
| Thread coupling | None (deferred) | No `thread_id` in log entries. Thread system will decide its own storage strategy when built. |
| DSPy integration | Manual cherry-pick (future) | Logs not automatically piped to DSPy. Future: inspect logs, select entries, reshape into eval examples. |

---

## Log Location

```
~/.wrap/logs/wrap.jsonl
```

Relative to `WRAP_HOME` (defaults to `~/.wrap`). The `logs/` directory is created lazily on first write.

---

## Log Entry Schema

Each line in `wrap.jsonl` is a single JSON object.

### Invocation-level fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique invocation ID (`crypto.randomUUID()`) |
| `timestamp` | string | ISO 8601 timestamp of invocation start |
| `version` | string | Wrap version from package.json (e.g., `"0.1.0"`) |
| `prompt` | string | User's natural language input |
| `cwd` | string | Working directory at invocation time |
| `piped_input` | string? | Piped stdin content (field defined, not yet wired) |
| `memory` | object? | Memory state at invocation time — full `Memory` object (all scopes). Omitted if empty. CWD-filtered subset can be reconstructed from `cwd` field. |
| `provider` | object | Provider config snapshot (API keys redacted) |
| `prompt_hash` | string | SHA-256 hex digest of system prompt components (precomputed by DSPy, exported from `prompt.optimized.ts`) |
| `rounds` | array | Array of LLM round-trips (see below) |
| `outcome` | string | `"success"` \| `"error"` \| `"refused"` |

### Round fields

Each element in `rounds`:

| Field | Type | Description |
|---|---|---|
| `raw_response` | string? | Verbatim LLM output (defined in type, not yet populated) |
| `parse_error` | string? | JSON parsing or schema validation error (defined in type, not yet populated) |
| `provider_error` | string? | Provider-level error (subprocess crash, network failure) |
| `parsed` | object? | Parsed `CommandResponse` object |
| `execution` | object? | `{ command, exit_code }` — present when a command was executed |
| `llm_ms` | number? | Wall-clock milliseconds for the LLM call (includes retry if applicable). |
| `exec_ms` | number? | Wall-clock milliseconds for command execution. Omitted if no command was executed. |

### Current limitations

- **Single round per query**: Currently one LLM call + optional retry per invocation. When probes and the multi-round loop are implemented, each probe/retry will be a separate round.
- **`raw_response` / `parse_error` not populated**: The structured output retry handles parse failures before logging captures the raw text. Fields exist for future use.

---

## Examples

### Successful command

```json
{"id":"a1b2c3d4-...","timestamp":"2026-03-21T14:30:00.123Z","prompt":"find all typescript files","cwd":"/Users/tal/projects","provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"command","command":"find . -name '*.ts'","risk_level":"low"},"execution":{"command":"find . -name '*.ts'","exit_code":0}}],"outcome":"success"}
```

### Parse failure (the primary debugging use case)

When `raw_response` and `parse_error` are wired up (see `specs/todo.md`), a malformed LLM response will look like:

```json
{"id":"b2c3d4e5-...","timestamp":"2026-03-21T14:31:00.456Z","prompt":"list docker containers","cwd":"/Users/tal","provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"raw_response":"I'd be happy to help! Here's the command:\n```bash\ndocker ps\n```","parse_error":"LLM returned invalid JSON."}],"outcome":"error"}
```

### Provider failure

```json
{"id":"c3d4e5f6-...","timestamp":"2026-03-21T14:32:00.789Z","prompt":"show disk usage","cwd":"/Users/tal","provider":{"type":"claude-code"},"prompt_hash":"e3b0c44...","rounds":[{"provider_error":"claude: command not found"}],"outcome":"error"}
```

---

## What Gets Logged

| Scenario | Logged? | Outcome |
|---|---|---|
| Successful command execution (exit 0) | Yes | `"success"` |
| Command execution with non-zero exit | Yes | `"error"` |
| LLM returns answer | Yes | `"success"` |
| Provider subprocess crashes | Yes — `provider_error` | `"error"` |
| Non-low risk command (confirmation needed) | Yes | `"refused"` |
| Probe response | Yes — as a round in the same entry | Entry continues (not yet implemented — currently errors with "not supported") |
| Provider init failure / config error / no args | No | — |

---

## Architecture

### Where logging hooks in

Logging wraps the query loop in `runQuery()`:

1. **Entry created** at function start with invocation-level fields
2. **Round populated** after LLM call — captures parsed response, execution result, or errors
3. **Entry written** to JSONL in a `finally` block, regardless of success/failure
4. **Logging errors are swallowed** — logging must never break the tool

### Prompt hash

Precomputed at DSPy optimization time and exported as `PROMPT_HASH` from `prompt.optimized.ts`. Not recomputed at runtime. The hash covers: system prompt + schema text + few-shot demos.

### stdout is sacred

All logging writes to the filesystem only. No logging output to stdout or stderr during normal operation.

---

## Relationship to Other Systems

- **Log viewer**: `w --log` subcommand (see `specs/subcommands.md`)
- **Threads (future)**: Independent. Threads may reference log entries by ID later.
- **Eval / DSPy (future)**: Logs are raw material for training data. Future cherry-pick workflow transforms entries into eval examples.
- **Memory**: Memory updates from `parsed.memory_updates` are visible in log entries but memory persistence is separate.

