# Wrap — To Do

All remaining implementation tasks. Completed features are omitted — see spec files for architecture reference.

---

## Core Query Loop

- [ ] User-edited commands skip auto-fix (architecture supports this, not yet wired)

## Input & Invocation

- [ ] Modifier extraction — `extractModifiers(argv)` phase before `parseInput()` (see `specs/verbose.md`)
- [ ] `--verbose` flag + `verbose` config key (see `specs/verbose.md`)
- [ ] Verbose module — `src/core/verbose.ts` with `initVerbose()`/`verbose()` (see `specs/verbose.md`)
- [ ] Mode detection from argv[0] / symlink name (w, wy, w!, w?)
- [ ] Alias setup — scan for available single-letter commands, write shell-specific glob-protected aliases (zsh `noglob`, bash `set -f`, fish fallback)
- [ ] Mode auto-detection (LLM decides command vs answer when no explicit flag)
- [ ] Piped input — see `specs/piped-input.md` for full design. Key tasks:
  - [ ] `readPipedInput()` — detect `!process.stdin.isTTY`, read with `Bun.stdin.text()`, ignore empty
  - [ ] Wire piped input through main → runQuery → assembleCommandPrompt → log entry
  - [ ] Truncation at `maxPipedTokens` with note to LLM about total size
  - [ ] `pipe_stdin` response schema field + re-pipe to spawned command via `Bun.spawn({ stdin: new Blob([...]) })`
  - [ ] `maxPipedTokens` config key (default 50,000)
  - [ ] System prompt section for piped input behavior
  - [ ] No-args + pipe: piped content becomes prompt (bypass --help dispatch)
  - [ ] Large input: currently truncates silently; replace with TUI confirmation when confirmation is built

## Execution & Safety (see specs/safety.md)

- [ ] Local safety rule engine — pattern list, `classifyLocal()`, integration in `query.ts` (see `specs/safety.md`)
- [ ] Adversarial eval samples — indirect phrasing, obfuscated commands, social engineering
- [ ] Piped injection eval samples (gated on `pipedInput` bridge support)
- [ ] Nonce delimiters for untrusted prompt sections
- [ ] System prompt instruction: piped input is data, not instructions
- [ ] Trust boundary fence in user message assembly
- [ ] Confirmation TUI — bordered panel with syntax-highlighted command, risk indicator, explanation
- [ ] Tiered confirmation keybindings (medium: Enter=run; high: y+Enter=run, Enter=cancel)
- [ ] `[D]escribe` option — send command back to LLM for detailed explanation
- [ ] `[F]ollow-up` option — text input for natural language refinement
- [ ] `[C]opy` option — copy command to clipboard
- [ ] Edit mode — editable command field in confirmation TUI
- [ ] Input buffer flush before rendering confirmation prompt
- [ ] No-TTY detection — fail early with clear stderr message if `/dev/tty` unavailable
- [ ] Interactive command detection + TTY handoff (vim, top, ssh, sudo)
- [ ] Shell history injection — append generated command with inline comment to shell history

## Discovery & Probes (see specs/discovery.md)

- [ ] Future: parse package.json scripts / Makefile targets into CWD context summary

## Error Handling & Auto-Fix

- [ ] Auto-fix scoped to infrastructure-level failures only (command not found, syntax errors, wrong flags)
- [ ] Command not found → LLM decides: memory update (system tool) vs path suggestion (local script)
- [ ] Feed infrastructure errors back to LLM for corrected command
- [ ] LLM classifies errors as fixable vs informational

## LLM Integration

- [ ] CLI provider terms-of-service disclaimer on first use
- [ ] Context assembly — curated env vars (PATH, EDITOR, SHELL), thread history

## Memory System

- [ ] Lazy probing — on-demand discovery via agent loop probe commands (gets smarter over time)

## Logging (see specs/logging.md for architecture)

- [ ] Round retry capture — nest first-attempt `raw_response`/`parse_error`/`llm_ms` inside `Round.retry` (design agreed, needs test provider changes)
- [ ] Wire `tools_available`/`tools_unavailable` to invocation-level log fields, `watchlist_additions` to round fields
- [ ] Wire `piped_input` field from stdin (see `specs/piped-input.md`)
- [ ] `cancelled` outcome type (blocked on confirmation TUI + signal handling)
- [ ] `expires` field + retention pruning (future)
- [ ] Document in help/README that logs contain full LLM exchanges

## Thread System

- [ ] Thread storage (user inputs, commands, stdout/stderr, LLM responses)
- [ ] Thread continuation via new invocation (`wyada` or similar)
- [ ] Thread TTL expiry
- [ ] Thread identification — link follow-up to parent (initially: most recent in current terminal)
- [ ] Large output warning before sending thread with large stored output to LLM

## Configuration & First-Run

- [ ] First-run config wizard TUI — provider selection, API key entry, model selection
- [ ] CLI tool provider detection (Claude Code, Codex, AMP) in wizard
- [ ] Alias setup in wizard — scan available single-letter commands, detect shell, write glob-protected aliases to shell rc file
- [ ] Full first-run flow: config wizard → alias setup → memory init → ready

## Output & UI

- [ ] Visual identity — distinctive color scheme, emoji prefix, characterful messages
- [ ] Answer rendering — colorful terminal markdown (syntax-highlighted code, bold/italic, lists). Blocked on TUI library.
- [ ] TUI components — radio buttons, checkboxes, free text input, editable fields

## Subcommands (see specs/subcommands.md)

- [ ] `--config` — manual reconfigure (reuses config wizard)
- [ ] `--memory` — view/manage memory

## Eval System

- [ ] Log-to-eval script — a script in `eval/` that parses `~/.wrap/logs/wrap.jsonl`, deduces feedback signals (exit codes, round retries, repeated prompts), identifies failure patterns and improvable scenarios, and outputs eval examples in `seed.jsonl` format for optimization.
- [ ] LLM-as-judge for context-sensitive eval samples (see eval spec)
- [ ] Evaluate conditional prompt sections. For example, piped input instructions (~150 tokens) are always in the system prompt even when unused. Consider a tested pattern for context-dependent prompt assembly that works with DSPy optimization. Applies to any future context-specific prompt sections too.

## Build & Distribution

- [ ] Man page (`man wrap`)
- [ ] tldr page
- [ ] Shell completions (bash/zsh/fish)

## Future Ideas

- [ ] Consider running Claude Code in user's cwd as CLI tool provider for filesystem context
- [ ] Model-switching shorthand — e.g., `W` (uppercase) uses premium model, `w` uses default
- [ ] Shell keybinding integration — keybinding reads raw line buffer (`$BUFFER` in zsh, `$READLINE_LINE` in bash) and sends to Wrap. Fully bypasses shell expansion (globs, `$()`, backticks). Aliases only protect against globs; this is the complete solution.
- [ ] Speculative LLM call for large piped input — check if command can consume stdin directly
- [ ] `--print` flag — generate command and print to stdout without executing. Implies force-cmd. Composability primitive for scripting, clipboard, shell widgets. Build alongside mode system (needs same input-parsing infra). Name `--print` not `--dry-run` (probes still execute).
- [ ] Piped input: `--full` flag to send complete content to LLM without truncation
- [ ] Piped input: temp-file buffering for very large inputs (avoid holding multi-GB strings in memory)
- [ ] Piped input: `Bun.stdin.bytes()` for binary-safe re-piping (current `text()` corrupts non-UTF-8)
- [ ] Interactive mode — `w` with no args opens a free-text prompt area (see `specs/interactive-mode.md`). Blocked on TUI lib.
