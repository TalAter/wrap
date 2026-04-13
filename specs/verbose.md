# Verbose Mode

> **Status:** Implemented

## Purpose

`--verbose` surfaces Wrap's internal pipeline in real-time on stderr so users can see what's happening: config loading, tool probing, LLM calls, retries, command execution. It's for debugging slow responses, unexpected behavior, or understanding how Wrap works.

Verbose shows the **narrative**; the structured log (`~/.wrap/logs/wrap.jsonl`, see `specs/logging.md`) holds the **data**. Verbose is a curated, human-friendly subset — raw responses, prompt hashes, full memory snapshots stay in the log.

## Enabling

Two equivalent paths:
- Flag: `w --verbose <prompt>` (leading position, like other modifiers)
- Config: `verbose: true` in `~/.wrap/config.jsonc`

No `-v` shorthand. No env var. `w --verbose` with no prompt shows help, same as `w` alone.

## Modifier, not subcommand

`--verbose` is a **modifier**: extracted from leading argv before `parseInput` runs, so it can precede prompts, flags, or nothing. Modifier specs live in `main.ts` (`MODIFIER_SPECS`); `src/core/input.ts` has no built-in knowledge of which modifiers exist. Other modifiers (`--model`, `--provider`) share the same mechanism.

## The verbose module

`src/core/verbose.ts` — reads from the global config store, import-anywhere:

- `verbose(msg)` — reads `getConfig().verbose`; no-op if false, otherwise emits a `verbose` notification through the bus (see `specs/logging.md`).
- `verboseHighlight(msg, highlight)` — same, but renders `highlight` at normal brightness against a dimmed prefix. Used for LLM response lines where the command/probe content needs to stand out.

Elapsed timestamps: `startTime` is lazily captured on the first `verbose()` call when config says verbose is enabled. Module-level var for timing only — the enabled flag comes from the config store.

No `initVerbose()` — the `--verbose` CLI flag is folded into config at `setConfig()` time in `main.ts`, so `getConfig().verbose` returns the resolved value everywhere.

Why emit through the notification bus instead of writing stderr directly: keeps all user-facing output funneling through one sink, so tests and alternate frontends (TUI) can intercept.

## Output format

`» [+{elapsed}s] {message}` — guillemet prefix, elapsed seconds with two decimals, dimmed. LLM response content is the only part rendered at normal brightness (via `verboseHighlight`).

All verbose lines go to **stderr** — never stdout (hard rule). Non-TTY stderr still gets output; the flag means "I want to see this" regardless of terminal. ANSI dim codes are always emitted; filtering tools handle them.

Example:

```
» [+0.00s] Config loaded (anthropic claude-sonnet-4-latest)
» [+0.03s] Tools: 28/34 available
» [+0.05s] Calling claude-sonnet-4-latest...
» [+1.24s] LLM responded (command, low): find . -name '*.ts' -mtime 0
» [+1.25s] Executing command...
» [+1.31s] Command exited (0)
```

## Steps reported

Every pipeline step is reported. Fast steps (<1ms) are still shown — verbose means verbose.

### Startup (main.ts)
- `Config loaded ({provider label})`
- `Provider initialized ({provider label})`
- `Temp dir: {path}` 
- `Tools: {available}/{total} available` (only when probing ran)
- `CWD: {N} files listed` (only when listing ran)

### Memory (memory.ts)
- `Memory: {N} facts ({G} global, {S} scoped)` — normal path
- `Init: probing OS and shell...` / `Init: calling LLM to extract system facts...` / `Init: {N} facts extracted` — first-run init path, **instead of** the normal Memory line

### Query loop (runner.ts, round.ts)
- `Round {N}/{maxRounds}` — at the start of each round after the first
- `Final round: must return command or answer` — when one round remains
- `Calling {model}...`
- `LLM parse error, retrying...` — on structured-output retry
- `LLM scratchpad: {text}` — printed before the LLM response line whenever `_scratchpad` is non-null (see `specs/scratchpad.md`). Newlines collapsed to ` \n ` so each scratchpad is one line.
- `LLM responded (command, {risk_level}): {content}` — content highlighted
- `LLM responded (reply, {N} chars)` — content not echoed (it goes to stdout)
- `LLM responded (step, {risk_level}): {content}` — content highlighted
- `LLM error: {message}` — on provider failure (network, auth, empty)
- `Step: {command}` / `Step exited ({code})`
- `Memory updated: {N} facts` (after successful response with memory_updates)
- `Watchlist: added {tools}` (when watchlist_additions present)

### Execution (session.ts)
- `Executing command...`
- `Command exited ({code})`

## Edge cases

- **`w --verbose` alone:** modifier extracted, input type is `none`, help is shown. Config never loads in that branch — `getConfig()` would throw, but `verbose()` is never called.
- **`w --verbose --help`:** modifier extracted, `--help` dispatched as subcommand. Verbose doesn't activate — subcommands exit before the query pipeline and config is never loaded.
- **Provider errors:** `LLM error: {message}` is emitted before the chrome error message.
- **Empty response:** `LLM responded (command, low): ` (empty content) appears, then chrome error "LLM returned an empty response."

## TODO

Steps defined in this spec but not yet wired (add `verbose()` calls when their features land):

- **Piped input** (`specs/piped-input.md`): `Piped input: {size}`, `Piped input truncated: ...`, `Re-piping {size} to command stdin`. Empty pipes emit nothing.
- **Context line**: `Context: {N} memory facts, {T} tools, {F} CWD files` before the first LLM call.
- **Error retry**: `Command failed ({code}), feeding error to LLM...` when a failed command is fed back to the model.
- **Risk escalation** (`specs/safety.md`): `Risk escalated: {llm} → {effective} (matched: {pattern})` — only when the local rule engine overrides the LLM's level.
