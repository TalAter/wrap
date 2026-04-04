# Wrap — Structured Logging

> Always-on invocation logging for debugging, observability, and future eval data.

---

## Motivation

When the LLM returns a malformed response (invalid JSON, schema mismatch), Wrap shows a terse error and exits. The raw LLM output is discarded — there's no way to inspect what actually came back. This makes debugging prompt issues, provider quirks, and schema mismatches impossible without reproducing the failure.

Logging solves this by capturing every LLM interaction to disk as it happens. The same data also serves as the foundation for future eval pipelines and thread/session history.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Always on | Yes | No `--verbose` or opt-in flag. Every invocation logs. You shouldn't need to predict failures. |
| Storage format | Single append-only JSONL file | One file, one line per invocation. Simple to tail, grep, parse. |
| Granularity | One record per invocation | A `rounds` array captures multi-step interactions (probes, error-fix attempts). Written once at end of invocation. |
| Null fields | Omitted | Fields with null values are omitted from the JSON to keep the file compact. Absence = null. |
| Sensitive data | Logged verbatim | Piped stdin, prompts, raw responses — all logged as-is. Same threat model as `~/.bash_history`. Local file on user's machine. |
| System prompt | Hash only | Per-invocation context (user prompt, cwd, piped input) is logged in full. System prompt + schema + few-shot examples are represented by a SHA-256 hash for reproducibility without bloat. Match hash to prompt version in git. |
| Memory | Full snapshot | The entire `Memory` object is logged, not just CWD-filtered facts. CWD is in the entry, so the reader can reconstruct which scopes matched. Logging full memory avoids duplicating the filtering logic and provides more context. |
| Timing | Per-round durations | `llm_ms` and `exec_ms` are stored as `performance.now()` deltas on each round, not as absolute timestamps. Keeps the data simple; total time can be derived by summing. |
| Round retries vs rounds | Nested, not flat | Round retries (transient JSON parse failures) are nested inside the round as a `retry` field. Real multi-turn interactions (probes) are separate rounds. This prevents conflating error recovery with meaningful conversation turns. |
| Thread coupling | None (deferred) | No `thread_id` in log entries. Thread system will decide its own storage strategy when built. |
| DSPy integration | Manual cherry-pick (future) | Logs are not automatically piped to DSPy. Future workflow: inspect logs, select interesting entries, reshape into eval examples. |
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
| `piped_input` | string? | Piped stdin content, truncated to first 1,000 characters for large inputs (see `specs/piped-input.md`). Omitted if not piped. |
| `memory` | object? | Memory state at invocation time — full `Memory` object (all scopes). Omitted if empty. CWD-filtered subset can be reconstructed from `cwd` field. |
| `tools_available` | string[]? | Tool names found by the runtime `which` probe (defaults + watchlist). Omitted if probe returned nothing. |
| `tools_unavailable` | string[]? | Tool names not found by the runtime `which` probe. Omitted if all tools were found. |
| `provider` | object | Provider config snapshot (e.g., `{"type": "claude-code", "model": "haiku"}`). API keys redacted to last 4 chars. |
| `prompt_hash` | string | SHA-256 hex digest of the system prompt components (see Prompt Hash Computation below) |
| `rounds` | array | Array of rounds (see below) |
| `outcome` | string | `"success"` \| `"error"` \| `"blocked"` \| `"cancelled"` \| `"max_rounds"` |

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
| `watchlist_additions` | string[]? | Tool names the LLM nominated for the watchlist in this round. Omitted when absent. Enables pruning: tools nominated long ago but never again may be stale. |
| `retry` | object? | (Not yet implemented) First-attempt failure when a round retry occurred. Contains `raw_response`, `parse_error`, and `llm_ms` from the failed attempt. Omitted when no retry happened. |

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
{"id":"a1b2c3d4-...","timestamp":"2026-03-21T14:30:00.123Z","version":"0.1.0","prompt":"find all typescript files","cwd":"/Users/tal/projects","memory":{"/":[{"fact":"macOS 14.6, Apple Silicon (arm64)"},{"fact":"zsh"}],"/Users/tal/projects":[{"fact":"uses bun"}]},"tools_available":["brew","git","node","bun","curl","jq","rg","pbcopy","pbpaste"],"tools_unavailable":["apt","dnf","pacman","yum"],"provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"command","content":"find . -name '*.ts'","risk_level":"low"},"execution":{"command":"find . -name '*.ts'","exit_code":0,"shell":"/bin/zsh"},"llm_ms":820,"exec_ms":45}],"outcome":"success"}
```

### Parse failure (the primary debugging use case)

```json
{"id":"b2c3d4e5-...","timestamp":"2026-03-21T14:31:00.456Z","version":"0.1.0","prompt":"list docker containers","cwd":"/Users/tal","memory":{"/":[{"fact":"macOS 14.6"}]},"provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"provider_error":"No object generated: could not parse output as JSON.","llm_ms":650}],"outcome":"error"}
```

### Provider failure

```json
{"id":"c3d4e5f6-...","timestamp":"2026-03-21T14:32:00.789Z","version":"0.1.0","prompt":"show disk usage","cwd":"/Users/tal","provider":{"type":"claude-code"},"prompt_hash":"e3b0c44...","rounds":[{"provider_error":"claude: command not found","llm_ms":12}],"outcome":"error"}
```

### Multi-round invocation (probe + command)

```json
{"id":"x9y8z7w6-...","timestamp":"2026-03-21T14:33:00.000Z","version":"0.1.0","prompt":"add alias to shell config","cwd":"/Users/tal","memory":{"/":[{"fact":"macOS 14.6"}]},"tools_available":["brew","git","node","bun","curl","jq","rg","pbcopy","pbpaste"],"tools_unavailable":["apt","dnf","pacman","yum","docker","kubectl","python3","tldr","fd","bat","eza","xclip","xsel","wl-copy","wl-paste"],"provider":{"type":"claude-code","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"probe","content":"echo $SHELL","risk_level":"low"},"execution":{"command":"echo $SHELL","exit_code":0,"shell":"/bin/zsh"},"llm_ms":400,"exec_ms":5},{"parsed":{"type":"command","content":"echo \"alias ll='ls -la'\" >> ~/.zshrc","risk_level":"medium"},"llm_ms":500}],"outcome":"success"}
```

### Watchlist growth (probe with watchlist_additions)

```json
{"id":"d4e5f6g7-...","timestamp":"2026-03-21T14:34:00.000Z","version":"0.1.0","prompt":"convert all gifs to pngs","cwd":"/Users/tal/images","tools_available":["brew","git","sips"],"tools_unavailable":["convert","magick"],"provider":{"type":"anthropic","model":"haiku"},"prompt_hash":"e3b0c44...","rounds":[{"parsed":{"type":"probe","content":"which sips convert magick mogrify pngquant optipng cwebp","risk_level":"low","watchlist_additions":["sips","convert","magick","mogrify","pngquant","optipng","cwebp"]},"watchlist_additions":["sips","convert","magick","mogrify","pngquant","optipng","cwebp"],"execution":{"command":"which sips convert magick mogrify pngquant optipng cwebp","exit_code":1,"shell":"/bin/zsh"},"llm_ms":600,"exec_ms":4},{"parsed":{"type":"command","content":"for f in *.gif; do sips -s format png \"$f\" --out \"${f%.gif}.png\"; done","risk_level":"low"},"execution":{"command":"for f in *.gif; do sips -s format png \"$f\" --out \"${f%.gif}.png\"; done","exit_code":0,"shell":"/bin/zsh"},"llm_ms":450,"exec_ms":120}],"outcome":"success"}
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
| Non-low risk command, no TTY | Yes | `"blocked"` |
| Non-low risk command, user cancels | Yes | `"cancelled"` |
| Probe round | Yes — as a round in the same entry, with `execution` capturing the probe command | |
| Round budget exhausted (all probes) | Yes | `"max_rounds"` |
| Provider initialization fails (e.g., unknown type) | No | — |
| No args / help screen | No | — |
| Config errors | No | — |
| Round retry (future) | Yes — nested in `round.retry`, not a separate round | |

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

The prompt hash is precomputed at DSPy optimization time and stored as `promptHash` in `src/prompt.optimized.json`. It is **not** recomputed at runtime — the optimizer writes it once when generating the file.

The hash versions the full **static prompt toolset**, not one invocation's exact prompt. It covers the generated prompt artifacts and fixed prompt fragments the runtime may use, including conditionally included static sections.

### Reproducibility

A log entry captures everything needed to reproduce an LLM call:
- **Prompt** — user's input
- **Memory** — full fact state at invocation time (CWD determines which scopes the LLM saw)
- **Tools** — available and unavailable tool lists from the runtime probe (determines what the LLM saw in `## Detected tools` / `## Unavailable tools`)
- **Prompt hash** — identifies the exact static prompt toolset version
- **Provider** — which model was called
- **Version** — which Wrap release was running

When piped input support is implemented (see `specs/piped-input.md`), `piped_input` completes the picture. Large piped inputs are aggressively truncated in logs (first 1,000 characters only) to keep log files manageable.

### stdout is sacred

All logging writes to the filesystem only. No logging output goes to stdout or stderr during normal operation.

---

## Relationship to Other Systems

- **Threads (future):** Logging and threads are independent. Threads may reference log entries by ID in the future, or maintain their own storage. Decided when threads are built.
- **Eval / DSPy (future):** Logs serve as raw material for eval examples. A future `wrap log export` command or manual cherry-pick workflow transforms log entries into examples (`eval/examples/seed.jsonl`). No automated pipeline.
- **Memory:** Memory state is snapshotted in each log entry. Memory updates from the LLM response are visible in `parsed.memory_updates`. Memory persistence is a separate system (`~/.wrap/memory.json`).
- **Tool watchlist (future):** `tools_available`/`tools_unavailable` capture the runtime probe results (defaults + watchlist). `watchlist_additions` in rounds tracks growth. Together these enable pruning: a tool added to the watchlist long ago that was never nominated again and was never found available is a candidate for removal. See `specs/discovery.md` — Tool Watchlist.

---

## TODO

- [ ] `tools_available` / `tools_unavailable` fields — `probeTools()` already returns structured data, just needs wiring to the log entry
- [ ] `watchlist_additions` round field — pass through from parsed LLM response
- [ ] Round retry capture — nest first-attempt `raw_response`/`parse_error`/`llm_ms` inside `Round.retry` (design agreed, needs test provider changes to test the round retry path)
- [ ] `piped_input` field — thread through from `readPipedInput` to both log entry and `assembleCommandPrompt` (see `specs/piped-input.md`)
- [ ] `cancelled` outcome (requires signal handling)
- [ ] `expires` field + retention pruning
- [ ] Document in help/README that logs contain full LLM exchanges
