# Verbose Mode

> **Status:** Implemented
> **Date:** 2026-03-31

## Purpose

`--verbose` surfaces Wrap's internal pipeline in real-time on stderr so users can see what's happening: config loading, tool probing, LLM calls, retries, command execution. Useful for debugging slow responses, unexpected behavior, or understanding how Wrap works.

## Enabling

Two ways to enable verbose mode:

1. **Flag:** `w --verbose <prompt>` — leading position only (before the prompt, consistent with other flags).
2. **Config:** `verbose: true` in `~/.wrap/config.jsonc`.

No `-v` shorthand. No env var.

The flag and config are equivalent — Wrap behaves identically regardless of which enabled verbose. `w --verbose` with no prompt shows help, same as `w` alone.

## Input Parsing: Modifier Extraction

`--verbose` is a **modifier**, not a subcommand. It's the first modifier flag in Wrap; the design supports future modifiers (e.g. `--yolo`, `--dry-run`).

A new `extractModifiers(argv)` phase runs before `parseInput()`:

```
argv: ["--verbose", "find", "files"]
         ↓
extractModifiers(argv)  →  { modifiers: { verbose: true }, remaining: ["find", "files"] }
         ↓
parseInput(remaining)   →  { type: "prompt", prompt: "find files" }
```

```
argv: ["--verbose", "--help"]
         ↓
extractModifiers(argv)  →  { modifiers: { verbose: true }, remaining: ["--help"] }
         ↓
parseInput(remaining)   →  { type: "flag", flag: "--help", args: [] }
```

```
argv: ["--verbose"]
         ↓
extractModifiers(argv)  →  { modifiers: { verbose: true }, remaining: [] }
         ↓
parseInput(remaining)   →  { type: "none" }  →  shows help
```

`extractModifiers` scans leading args, peels off known modifiers, returns the rest. `parseInput` stays unchanged — it never sees modifiers. The `Modifiers` type starts as `{ verbose: boolean }` and grows as new modifiers are added.

## The verbose Module

A dedicated `src/core/verbose.ts` module with set-once initialization:

- `initVerbose(enabled: boolean)` — called once from `main.ts` after config loads (or after modifier extraction, whichever is earlier). Records start time for elapsed timestamps.
- `verbose(msg: string)` — emits a formatted line to stderr if enabled; no-op if disabled. Any module can import and call this without threading state.

This follows the same pattern as `chrome()` in `output.ts` — a module-level function importable anywhere — except it's conditional.

### Timer

`initVerbose` captures `performance.now()` as the start time. Each `verbose()` call computes elapsed time from that baseline.

## Output Format

All verbose lines go to **stderr** (never stdout — per the hard stdout rule).

Format: `» [+{elapsed}s] {message}`

- **`»`** — guillemet prefix, consistent across all verbose lines.
- **`[+{elapsed}s]`** — seconds elapsed since Wrap started, two decimal places (e.g. `+0.03s`, `+1.24s`).
- **`{message}`** — the step description.

The entire line is rendered in **dim** text (ANSI dim). Exception: in the LLM response line, the command/answer content is rendered at normal brightness for contrast.

Example full output:

```
» [+0.00s] Config loaded (anthropic)
» [+0.01s] Memory: 5 facts (2 global, 3 scoped)
» [+0.03s] Tools: 28/34 available
» [+0.04s] CWD: 47 files listed
» [+0.05s] Calling claude-sonnet-4-latest...
» [+1.24s] LLM responded (command, low risk): find . -name '*.ts' -mtime 0
» [+1.25s] Executing command...
» [+1.31s] Command exited (0)
```

## Steps Reported

Every step in the pipeline is reported. Fast steps (<1ms) are still shown — verbose means verbose.

### Startup phase

| Step | Message format | When |
|------|---------------|------|
| Config | `Config loaded ({provider type})` | After `loadConfig()` returns |
| Provider | `Provider initialized ({model})` | After `initProvider()` — include model name if configured |
| Memory | `Memory: {N} facts ({G} global, {S} scoped)` | After `ensureMemory()` returns (non-init path) |
| Tools | `Tools: {available}/{total} available` | After `probeTools()` returns |
| CWD files | `CWD: {N} files listed` | After `listCwdFiles()` returns |

### First-run init (inside ensureMemory)

When no `memory.json` exists, verbose shows the init sub-steps:

| Step | Message format |
|------|---------------|
| Init probes | `Init: probing OS and shell...` |
| Init LLM | `Init: calling LLM to extract system facts...` |
| Init done | `Init: {N} facts extracted` |

These appear _instead of_ the normal "Memory: N facts" line.

### Piped input (see `specs/piped-input.md`)

Reported after stdin is read, before config loading.

| Step | Message format |
|------|---------------|
| Detected | `Piped input: {size}` (human-friendly: bytes, KB, or MB) |
| Truncated | `Piped input truncated: showing ~{truncated_size} of {total_size}` (only when exceeding `maxPipedTokens`) |
| Re-piped | `Re-piping {size} to command stdin` (when `pipe_stdin: true` in response) |

Empty pipes (whitespace-only) are treated as no pipe — no verbose line emitted.

### Query phase

| Step | Message format |
|------|---------------|
| Context | `Context: {N} memory facts, {T} tools, {F} CWD files` |
| LLM call | `Calling {model}...` |
| LLM retry | `LLM parse error, retrying...` (only on structured output failure) |
| LLM response (command) | `LLM responded (command, {risk}): {command content}` — command content at normal brightness |
| LLM response (answer) | `LLM responded (answer, {length} chars)` — don't echo content (it goes to stdout) |
| LLM response (probe) | `LLM responded (probe): {probe command}` |
| LLM error | `LLM error: {message}` |

### Multi-round loop (see `specs/discovery.md` §LLM Probes)

When the LLM returns `type: "probe"` or a command fails and triggers error-retry, the query enters a multi-round loop. Verbose tracks rounds against the budget.

| Step | Message format |
|------|---------------|
| Probe executing | `Probe: {command}` |
| Probe result | `Probe exited ({code})` |
| Error retry | `Command failed ({code}), feeding error to LLM...` |
| Round count | `Round {N}/{maxRounds}` (shown at the start of each round after the first) |
| Last round | `Final round: must return command or answer` (when only 1 round remains) |

### Risk classification (see `specs/safety.md`)

When the local rule engine escalates the LLM's risk level, verbose shows the override.

| Step | Message format |
|------|---------------|
| Escalation | `Risk escalated: {LLM level} → {effective level} (matched: {pattern description})` |

Only shown when the rule engine actually escalates. When LLM and rule engine agree, no extra line — the risk is already visible in the LLM response line.

### Execution phase

| Step | Message format |
|------|---------------|
| Execute | `Executing command...` |
| Exit | `Command exited ({code})` |

### Memory/watchlist updates

| Step | Message format |
|------|---------------|
| Memory update | `Memory updated: {N} facts` |
| Watchlist | `Watchlist: added {tools}` |

### Extended example: multi-round with probe

```
» [+0.00s] Config loaded (anthropic)
» [+0.01s] Piped input: 12.4MB
» [+0.01s] Piped input truncated: showing ~200KB of 12.4MB
» [+0.02s] Memory: 8 facts (3 global, 5 scoped)
» [+0.04s] Tools: 31/38 available
» [+0.05s] CWD: 23 files listed
» [+0.06s] Calling claude-sonnet-4-latest...
» [+1.10s] LLM responded (probe): sed -n '12570000p'
» [+1.10s] Re-piping 12.4MB to command stdin
» [+1.10s] Probe: sed -n '12570000p'
» [+1.15s] Probe exited (0)
» [+1.15s] Round 2/5
» [+1.15s] Calling claude-sonnet-4-latest...
» [+2.30s] LLM responded (answer, 245 chars)
```

### Extended example: risk escalation

```
» [+0.05s] Calling claude-sonnet-4-latest...
» [+1.20s] LLM responded (command, low): chmod 777 /etc/hosts
» [+1.20s] Risk escalated: low → medium (matched: chmod)
```

## Relationship to Structured Logging

Verbose output is a **curated, human-friendly subset** of what the structured logger captures. The log file (`~/.wrap/logs/wrap.jsonl`) remains the source of truth for full diagnostic detail (raw responses, prompt hashes, full memory snapshots). Verbose shows the narrative; the log has the data.

## Edge Cases

- **Non-TTY stderr:** Verbose still outputs if enabled. The flag/config means "I want to see this" regardless of terminal. ANSI dim codes are included — filtering tools handle them.
- **`w --verbose` alone:** Shows help (type "none" after modifier extraction). Verbose doesn't activate because initVerbose hasn't been called yet (config hasn't loaded). This is fine — help doesn't need verbose.
- **`w --verbose --log`:** Modifier extracted, then `--log` dispatched as subcommand. Verbose doesn't activate for subcommands (they exit before the query pipeline).
- **Provider errors:** If the LLM call throws (network failure, auth error), verbose shows the `LLM error: {message}` line before the chrome error message appears.
- **Empty response:** Verbose shows `LLM responded (command, low risk):` with empty content, then the chrome error "LLM returned an empty response." appears.
