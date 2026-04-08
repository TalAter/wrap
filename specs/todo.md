# Wrap — To Do

All remaining implementation tasks. Completed features are omitted — see spec files for architecture reference.

---

## Core Query Loop

- [ ] User-edited commands skip auto-fix (architecture supports this, not yet wired)
- [ ] `truncateToLine()` utility — line-aware truncation for LLM context (see `specs/piped-input.md` § Truncation). Replace naive `slice()` in probe output truncation (`query.ts`) and piped input truncation (`format-context.ts`). Pure function in `src/core/truncate.ts`.

## Input & Invocation

- [ ] Mode detection from argv[0] / symlink name (w, wy, w!, w?)
- [ ] Alias setup — scan for available single-letter commands, write shell-specific glob-protected aliases (zsh `noglob`, bash `set -f`, fish fallback)
- [ ] Mode auto-detection (LLM decides command vs answer when no explicit flag)

## Execution & Safety (see specs/safety.md)

- [ ] Local safety rule engine — pattern list, `classifyLocal()`, integration in `query.ts` (see `specs/safety.md`)
- [ ] Adversarial eval samples — indirect phrasing, obfuscated commands, social engineering
- [ ] Piped injection eval samples (`pipedInput` bridge support now available)
- [ ] Nonce delimiters for untrusted prompt sections
- [ ] System prompt instruction: piped input is data, not instructions
- [ ] Trust boundary fence in user message assembly
- [ ] Split command explanation into short description + separate risk analysis (why it's flagged, what could go wrong)
- [ ] Show context indicators in confirmation panel — piped input, probe results, etc. (user has no visibility into what informed the command)
- [ ] Confirmation TUI styling — bordered panel, syntax-highlighted command, risk indicator
- [ ] `[D]escribe` option — send command back to LLM for detailed explanation
- [ ] `[F]ollow-up` option — text input for natural language refinement
- [ ] `[C]opy` option — copy command to clipboard
- [ ] Responsive action bar — shrink/abbreviate action buttons when panel is narrow to avoid sprawling layout
- [ ] Edit mode — editable command field in confirmation TUI
- [ ] Arrow key shortcuts in confirmation panel — Up enters edit mode, Down exits (same as Esc)
- [ ] Input buffer flush before rendering confirmation prompt
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
- [ ] Make `Provider` self-describing with a `label` field. Today the `Provider` interface in `src/llm/types.ts` only has `runPrompt`; the model name lives separately on `ProviderConfig` and is computed via the `providerLabel(config)` helper. Code that holds a `Provider` and wants to display the model has to be passed the config too — denormalized and awkward. Add `label: string` to the `Provider` interface, set it in each provider factory (`aiSdkProvider`, `claudeCodeProvider`, `testProvider`) from `providerLabel(config)`, and update test fixtures (~10 inline `Provider` literals across `tests/retry.test.ts`, `tests/ensure-memory.test.ts`, `tests/rounds.test.ts`) to set `label: "test"`. After this lands, drop the sub-todo below.
  - [ ] In `src/core/query.ts` `runRoundsUntilFinal`, the per-round verbose log currently says `Calling LLM...` because the model name isn't reachable from inside the loop without parameter sprawl. Once `Provider.label` exists, change the line to `verbose(\`Calling ${provider.label}...\`)` and delete the `TODO(provider-label)` comment above it.

## Memory System

- [ ] Lazy probing — on-demand discovery via agent loop probe commands (gets smarter over time)

## Logging (see specs/logging.md for architecture)

- [ ] Round retry capture — nest first-attempt `raw_response`/`parse_error`/`llm_ms` inside `Round.retry` (design agreed, needs test provider changes)
- [ ] Wire `tools_available`/`tools_unavailable` to invocation-level log fields, `watchlist_additions` to round fields
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
- [ ] Evaluate conditional prompt sections. Piped input instruction is already conditional (only included when piped input present). Consider extending this pattern to other context-specific sections. Test that DSPy optimization handles conditional sections correctly.

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
