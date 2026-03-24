# Wrap — To Do

All implementation tasks extracted from SPEC.md, ARCHITECTURE.md, memory.md, and logging.md.

---

## Core Query Loop

- [ ] Multi-round loop — probes, retries, and auto-fix within unified round counter (`maxRounds`)
- [ ] Multi-turn conversation context — probe results and errors as conversation turns passed to LLM
- [ ] Define MAX_ROUNDS exhaustion behavior (show accumulated errors? last error? summary?)
- [ ] User-edited commands skip auto-fix (architecture supports this, not yet wired)

## Input & Invocation

- [ ] Mode detection from argv[0] / symlink name (w, wy, w!, w?)
- [ ] Alias/symlink setup — scan for available single-letter commands on first run
- [ ] Mode auto-detection (LLM decides command vs answer when no explicit flag)
- [ ] Subcommand detection and dispatch (`runSubcommand()`)
- [ ] Detect piped stdin, read full content into buffer, pass to LLM as context
- [ ] Large input warning TUI — token estimate, confirmation before sending
- [ ] Hard ceiling — reject input over max size (e.g., 50MB)

## Execution & Safety

- [ ] Local safety rule engine — hard-coded patterns (rm -rf, sudo, dd, chmod, mkfs, etc.)
- [ ] Confirmation TUI — bordered panel with syntax-highlighted command, risk indicator, explanation
- [ ] Tiered confirmation keybindings (medium: Enter=run; high: y+Enter=run, Enter=cancel)
- [ ] `[D]escribe` option — send command back to LLM for detailed explanation
- [ ] `[F]ollow-up` option — text input for natural language refinement
- [ ] `[C]opy` option — copy command to clipboard
- [ ] Edit mode — editable command field in confirmation TUI
- [ ] Input buffer flush before rendering confirmation prompt
- [ ] No-TTY detection — fail early with clear stderr message if `/dev/tty` unavailable
- [ ] Interactive command detection + TTY handoff (vim, top, ssh, sudo)
- [ ] Long-running command passthrough (streaming stdout/stderr)
- [ ] Shell history injection — append generated command with inline comment to shell history

## Agent Loop (Probes)

- [ ] Probe command execution (silent, not shown in stdout)
- [ ] Subtle stderr/tty indicator during probes (e.g., `🔍 Checking shell type...`)
- [ ] Probe results fed back to LLM as context

## Error Handling & Auto-Fix

- [ ] Auto-fix scoped to infrastructure-level failures only (command not found, syntax errors, wrong flags)
- [ ] Command not found → LLM decides: memory update (system tool) vs path suggestion (local script)
- [ ] Feed infrastructure errors back to LLM for corrected command
- [ ] LLM classifies errors as fixable vs informational

## LLM Integration

- [ ] OpenAI SDK provider (API-based providers with `response_format`)
- [ ] Generalized CLI tool provider abstraction (currently only claude-code)
- [ ] CLI provider terms-of-service disclaimer on first use
- [ ] JSON parse retry (one retry with stricter prompt on malformed JSON)
- [ ] Context assembly — curated env vars (PATH, EDITOR, SHELL), thread history, piped stdin
- [ ] Explain `memory_updates` usage in system prompt — when to write memories, what's worth remembering

## Memory System

- [ ] `loadMemory` / `saveMemory` / `ensureMemory` / `appendMemory` module
- [ ] Write memory from LLM `memory_updates` field (immediately, even mid-loop)
- [ ] Notify user on stderr/tty when new fact learned
- [ ] Eager init on first run — run probes, send to LLM, parse into facts
- [ ] Finalize probe commands — current list is provisional, ideally run all with one or few shell commands
- [ ] Init UX — spinner + summary line on stderr
- [ ] Update `memory_updates` in Zod response schema (key/value → fact)
- [ ] Update embedded schema text in `src/prompt.optimized.ts` to match
- [ ] Pass memory to `runCommandPrompt` — provider incorporates facts into system prompt
- [ ] Lazy probing — on-demand discovery via agent loop probe commands (gets smarter over time)

## Thread System

- [ ] Thread storage (user inputs, commands, stdout/stderr, LLM responses)
- [ ] Thread continuation via follow-up invocation (`wyada` or similar)
- [ ] Thread TTL expiry
- [ ] Thread identification — link follow-up to parent (initially: most recent in current terminal)
- [ ] Large output warning before sending thread with large stored output to LLM

## Logging

- [ ] Log module (`src/logging/`) — create log entry, append rounds, write JSONL
- [ ] Log entry creation at start of `runQuery` with invocation-level fields
- [ ] Round appending after each LLM call (raw_response, parse_error/provider_error, parsed, execution)
- [ ] JSONL writing to `~/.wrap/logs/wrap.jsonl` at end of `runQuery`
- [ ] Prompt hash — exported from `src/prompt.optimized.ts`, not recomputed at runtime
- [ ] Lazy `logs/` directory creation on first write
- [ ] Omit null fields from JSON output
- [ ] `piped_input` field — pass through from `parseInput` to log entry
- [ ] Multi-round logging — probe + retry rounds accumulate in the same entry
- [ ] `cancelled` outcome (requires signal handling)
- [ ] `max_rounds` outcome (requires probe/retry loop)
- [ ] `expires` field + retention pruning
- [ ] Tests — assert on log file contents in integration tests (WRAP_HOME already isolated)
- [ ] Document in help/README that logs contain full LLM exchanges

## Configuration & First-Run

- [ ] First-run config wizard TUI — provider selection, API key entry, model selection
- [ ] CLI tool provider detection (Claude Code, Codex, AMP) in wizard
- [ ] Alias setup in wizard — scan available single-letter commands, create symlinks/aliases
- [ ] Full first-run flow: config wizard → alias setup → memory init → ready

## Output & UI

- [ ] Visual identity — distinctive color scheme, emoji prefix, characterful messages
- [ ] TUI components — radio buttons, checkboxes, free text input, editable fields

## Eval System

- [ ] Structured JSONL logging for evals (opt-in)
- [ ] Implicit feedback signal (exit code, retry, thread correction)
- [ ] DSPy eval infrastructure in container

## Subcommands (see specs/subcommands.md)

Implementation order: registry infra → --version → --help → --log.

### 1. Registry & dispatch infrastructure

- [ ] `Subcommand` type definition (`src/subcommands/types.ts`)
- [ ] Subcommand registry (`src/subcommands/registry.ts`) — single source of truth
- [ ] Dispatcher with generic arg validation (`src/subcommands/dispatch.ts`)
- [ ] Flag detection in `parseInput()` — first arg `--` prefix check
- [ ] Input type update — discriminated union: prompt | flag | none
- [ ] Short-circuit in `main()` — dispatch before ensure steps

### 2. `--version`

- [ ] Reads from package.json, prints to stdout

### 3. `--help`

- [ ] Auto-generated from registry (preamble + dynamic flags table)

### 4. `--log` / `--log-pretty`

- [ ] `--log` — raw JSONL output to stdout (all entries or last N)
- [ ] `--log-pretty` — indented JSON, jq piping when TTY + jq available
- [ ] Shared `isTTY()` utility in `src/core/tty.ts`
- [ ] Empty state — stderr "No log entries yet.", exit 0
- [ ] Corrupt JSONL line handling — skip with stderr warning
- [ ] jq detection via `Bun.which("jq")`

### Deferred subcommands

- [ ] `--config` — manual reconfigure (reuses config wizard)
- [ ] `--memory` — view/manage memory

## Build & Distribution

- [ ] Embed version at build time — `version.ts` reads `package.json` via `import.meta.url` which breaks in compiled binary (`bun build --compile`)

## Future Ideas

- [ ] Consider running Claude Code in user's cwd as CLI tool provider for filesystem context
- [ ] Model-switching shorthand — e.g., `W` (uppercase) uses premium model, `w` uses default
- [ ] Shell keybinding integration — keybinding sends current command line text to Wrap
- [ ] Speculative LLM call for large piped input — check if command can consume stdin directly
