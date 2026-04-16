# Wrap — To Do

All remaining implementation tasks. Completed features are omitted — see `vault/` notes for architecture reference.

---

## Core Query Loop

- [ ] User-edited commands skip auto-fix (architecture supports this, not yet wired)
- [ ] `truncateToLine()` utility — line-aware truncation for LLM context. Replace naive `slice()` in captured-output truncation (`runner.ts`) and piped input truncation (`format-context.ts`). Pure function in `src/core/truncate.ts`.
- [ ] Verbose `Context: {N} memory facts, {T} tools, {F} CWD files` line before the first LLM call.

## Input & Invocation

- [ ] Mode detection from argv[0] / symlink name (w, wy, w!, w?)
- [ ] Alias setup — scan for available single-letter commands, write shell-specific glob-protected aliases (zsh `noglob`, bash `set -f`, fish fallback)
- [ ] Mode auto-detection (LLM decides command vs answer when no explicit flag)

## Execution & Safety (see [[safety]])

- [ ] Local safety rule engine — pattern list, `classifyLocal()`, integration ahead of the execution gate (see [[safety]])
- [ ] Verbose `Risk escalated: {llm} → {effective} (matched: {pattern})` line when the local rule engine overrides the LLM's level.
- [ ] Adversarial eval samples — indirect phrasing, obfuscated commands, social engineering
- [ ] Piped injection eval samples (`pipedInput` bridge support now available)
- [ ] Nonce delimiters for untrusted prompt sections
- [ ] System prompt instruction: piped input is data, not instructions
- [ ] Trust boundary fence in user message assembly
- [ ] Split command explanation into short description + separate risk analysis (why it's flagged, what could go wrong)
- [ ] Show context indicators in dialog — piped input, prior step output, etc. (user has no visibility into what informed the command)
- [ ] Dialog styling — border, syntax-highlighted command, risk indicator
- [ ] `[D]escribe` option — send command back to LLM for detailed explanation
- [ ] `[C]opy` option — copy command to clipboard
- [ ] Responsive action bar — shrink/abbreviate action buttons when dialog is narrow to avoid sprawling layout
- [ ] Arrow key shortcuts in dialog — Up enters edit mode, Down exits (same as Esc)
- [ ] Interactive command detection + TTY handoff (vim, top, ssh, sudo)
- [ ] Shell history injection — append generated command with inline comment to shell history

## Discovery & Steps (see [[discovery]])

- [ ] Future: parse package.json scripts / Makefile targets into CWD context summary
- [ ] Investigate whether non-final step rounds should be able to read stdin.

## Error Handling & Auto-Fix

- [ ] Auto-fix scoped to infrastructure-level failures only (command not found, syntax errors, wrong flags)
- [ ] Command not found → LLM decides: memory update (system tool) vs path suggestion (local script)
- [ ] Feed infrastructure errors back to LLM for corrected command
- [ ] LLM classifies errors as fixable vs informational
- [ ] Verbose `Command failed ({code}), feeding error to LLM...` line when a failed command is fed back.

## LLM Integration

- [ ] CLI provider terms-of-service disclaimer on first use
- [ ] Context assembly — curated env vars (PATH, EDITOR, SHELL), thread history
- [ ] Make `Provider` self-describing with a `label` field. Today the `Provider` interface in `src/llm/types.ts` only has `runPrompt`; the display label lives separately on `ResolvedProvider` and is computed via `formatProvider(resolved)`. Code that holds a `Provider` and wants to display the model has to be passed the resolved provider too — denormalized and awkward. Add `label: string` to the `Provider` interface, set it in each provider factory (`aiSdkProvider`, `claudeCodeProvider`, `testProvider`) from `formatProvider(resolved)`, and update test fixtures to set `label: "test / test"`. After this lands, drop the `model` field from `LoopOptions` / `RunRoundOptions` and read `provider.label` directly inside `runRound` and `runLoop`.
- [ ] Migrate openai-compat kind from `@ai-sdk/openai` + baseURL to `@ai-sdk/openai-compatible`. The latter is Vercel's recommended wrapper for generic OpenAI-compatible endpoints (LM Studio, NVIDIA NIM, Ollama, OpenRouter, Groq, Mistral, etc.), exposes a `supportsStructuredOutputs` flag, and decouples our code from OpenAI-specific quirks. Today `src/llm/providers/ai-sdk.ts` uses `@ai-sdk/openai` + `baseURL` for Ollama which still works, but the idiomatic path is worth adopting before we add more openai-compat providers through the config wizard.
- [ ] Add Google (Gemini) support. Bundle `@ai-sdk/google`, add a `kind: "google"` branch in `src/llm/providers/registry.ts` + factory wiring in `src/llm/providers/ai-sdk.ts`, and uncomment the `google` entry in `API_PROVIDERS` in `src/llm/providers/registry.ts`. Google's OpenAI-compat endpoint has gaps in structured-output support, so going through the dedicated SDK is required rather than optional.

## Memory System

- [ ] Lazy probing — on-demand discovery via agent loop non-final step commands (gets smarter over time)

## Logging (see [[logging]])

- [ ] Round retry capture — nest first-attempt `raw_response`/`parse_error`/`llm_ms` inside `Round.retry` (design agreed, needs test provider changes)
- [ ] Wire `tools_available`/`tools_unavailable` to invocation-level log fields, `watchlist_additions` to round fields
- [ ] `expires` field + retention pruning (future)
- [ ] Document in help/README that logs contain full LLM exchanges

## Thread System

- [ ] Thread storage (user inputs, commands, stdout/stderr, LLM responses)
- [ ] Thread continuation via new invocation (`wyada` or similar)
- [ ] Thread TTL expiry
- [ ] Thread identification — link follow-up to parent (initially: most recent in current terminal)
- [ ] Large output warning before sending thread with large stored output to LLM

## Configuration & First-Run

- [ ] Alias setup in wizard — scan available single-letter commands, detect shell, write glob-protected aliases to shell rc file
- [ ] Full first-run flow: config wizard → alias setup → ready
- [ ] Auto-generate `src/config/config.schema.json` from SETTINGS so the two can't drift — until then, adding a persistent setting means editing both.

## Output & UI

- [ ] Extract shared `KeyHints` component — `config-wizard-dialog.tsx` and `response-dialog.tsx` have near-identical implementations. Deduplicate into `src/tui/key-hints.tsx` with configurable indent.
- [ ] Visual identity — distinctive color scheme, emoji prefix, characterful messages
- [ ] Answer rendering — colorful terminal markdown (syntax-highlighted code, bold/italic, lists). Blocked on TUI library.
- [ ] TUI components — radio buttons, checkboxes, free text input, editable fields
- [ ] High contrast mode — backgrounds on dialogs, high contrast colors

## Subcommands (see [[subcommands]])

- [ ] `--config` / `--init` flags — ship the wizard's re-run mode with preselect-from-current-config semantics so unchecking a provider removes it. See [[config]]. `--init` is an alias at first; eventually grows into a broader first-run orchestrator (config + alias setup + anything else).
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

- [ ] Model-switching shorthand — e.g., `W` (uppercase) uses premium model, `w` uses default
- [ ] Shell keybinding integration — keybinding reads raw line buffer (`$BUFFER` in zsh, `$READLINE_LINE` in bash) and sends to Wrap. Fully bypasses shell expansion (globs, `$()`, backticks). Aliases only protect against globs; this is the complete solution.
- [ ] Speculative LLM call for large piped input — check if command can consume stdin directly
- [ ] `--print` flag — generate command and print to stdout without executing. Implies force-cmd. Composability primitive for scripting, clipboard, shell widgets. Build alongside mode system (needs same input-parsing infra). Name `--print` not `--dry-run` (non-final steps still execute).
- [ ] Piped input: `--full` flag to send complete content to LLM without truncation
- [ ] Piped input: temp-file buffering for very large inputs (avoid holding multi-GB strings in memory)
- [ ] Piped input: `Bun.stdin.bytes()` for binary-safe re-piping (current `text()` corrupts non-UTF-8)
- [ ] Piped input verbose lines — `Piped input: {size}`, `Piped input truncated: ...`, `Re-piping {size} to command stdin` when piping to the child. Empty pipes emit nothing.
- [ ] Interactive mode — `w` with no args opens a free-text prompt area (see [[interactive-mode]]). Blocked on TUI lib.
- [ ] Contextual prompt sections — inject domain-specific context when CWD signals are present (e.g. if CWD listing contains `package.json`, include a brief section about Node project conventions like `<runner> run <script>` vs built-in subcommands). Keeps the base prompt general while giving the LLM targeted hints when they'd help most. Could also cover Makefile, Cargo.toml, pyproject.toml, etc.
