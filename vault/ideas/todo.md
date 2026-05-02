# Wrap — To Do

All remaining implementation tasks. Completed features are omitted — see `vault/` notes for architecture reference.

---

## Core Query Loop

- [ ] Verbose `Context: {N} memory facts, {T} tools, {F} CWD files` line before the first LLM call.

## Input & Invocation

- [ ] Alias setup — scan for available single-letter commands, write shell-specific glob-protected aliases (zsh `noglob`, bash `set -f`, fish fallback)
- [ ] Mode auto-detection (LLM decides command vs answer when no explicit flag)

## Execution & Safety (see [[safety]])

- [ ] Local safety rule engine — pattern list, `classifyLocal()`, integration ahead of the execution gate (see [[safety]])
- [ ] Verbose `Risk escalated: {llm} → {effective} (matched: {pattern})` line when the local rule engine overrides the LLM's level.
- [ ] Adversarial eval samples — indirect phrasing, obfuscated commands, social engineering
- [ ] Attached-input injection eval samples (bridge wires `attachedInputPreview` / path / size / truncated)
- [ ] Nonce delimiters for untrusted prompt sections
- [ ] System prompt instruction: attached input is data, not instructions
- [ ] Trust boundary fence in user message assembly
- [ ] Split command explanation into short description + separate risk analysis (why it's flagged, what could go wrong)
- [ ] Show context indicators in dialog — attached input, prior step output, etc. (user has no visibility into what informed the command)
- [ ] `[C]opy` option — copy command to clipboard (reducer action exists as stub no-op in `src/session/reducer.ts`; needs real clipboard write)
- [ ] Arrow key shortcuts in dialog — Up enters edit mode, Down exits (same as Esc)
- [ ] Shell history injection — append generated command with inline comment to shell history

## Discovery & Steps (see [[discovery]])

- [ ] Future: parse package.json scripts / Makefile targets into CWD context summary
- [ ] Investigate whether non-final step rounds should be able to read stdin.

## Error Handling & Auto-Fix

- [ ] Auto-fix scoped to infrastructure-level failures only (command not found, syntax errors, wrong flags)
- [ ] Skip auto-fix when `SessionOutcome.run.source === "user_override"` — user's edit is intent, don't bounce their failed command back to LLM
- [ ] Command not found → LLM decides: memory update (system tool) vs path suggestion (local script)
- [ ] Feed infrastructure errors back to LLM for corrected command
- [ ] LLM classifies errors as fixable vs informational
- [ ] Verbose `Command failed ({code}), feeding error to LLM...` line when a failed command is fed back.

## LLM Integration

- [ ] Context assembly — curated env vars (PATH, EDITOR, SHELL), thread history
- [ ] Add Google (Gemini) support. Bundle `@ai-sdk/google`, add a `kind: "google"` branch in `src/llm/providers/registry.ts` + factory wiring in `src/llm/providers/ai-sdk.ts`, and uncomment the `google` entry in `API_PROVIDERS` in `src/llm/providers/registry.ts`. Google's OpenAI-compat endpoint has gaps in structured-output support, so going through the dedicated SDK is required rather than optional.

## Logging (see [[logging]])

- [ ] Round retry capture — nest first-attempt `raw_response`/`parse_error`/`llm_ms` inside `Round.retry` (design agreed, needs test provider changes)
- [ ] Wire `tools_available`/`tools_unavailable` to invocation-level log fields, `watchlist_additions` to round fields
- [ ] `expires` field + retention pruning (future)

## Thread System

- [ ] Thread storage (user inputs, commands, stdout/stderr, LLM responses)
- [ ] Thread continuation via new invocation (`wyada` or similar)
- [ ] Thread TTL expiry
- [ ] Thread identification — link follow-up to parent (initially: most recent in current terminal)
- [ ] Large output warning before sending thread with large stored output to LLM

## Configuration & First-Run

- [ ] Alias setup in wizard — scan available single-letter commands, detect shell, write glob-protected aliases to shell rc file
- [ ] Full first-run flow: config wizard → alias setup → ready

## Output & UI

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

- [ ] For any packager we ship through, wire up shell completion install. Each channel has its own mechanism (Homebrew's `generate_completions_from_executable`, distro packages staging pre-generated files into `/usr/share/bash-completion/completions/` etc.). Whenever a new distribution channel is added, completion install is part of that work.
- [ ] Wizard backstop for shell completions.
- [ ] Manual end-to-end test of shell completions on bash + fish after install. Automated `bash -n` / `fish --no-execute` tests cover syntax only — real UX (tab behavior, provider colon suffix, alias exclusion) needs a human in each shell.
- [ ] Man page (`man wrap`)
- [ ] tldr page

## Future Ideas

- [ ] Model-switching shorthand — e.g., `W` (uppercase) uses premium model, `w` uses default
- [ ] Shell keybinding integration — keybinding reads raw line buffer (`$BUFFER` in zsh, `$READLINE_LINE` in bash) and sends to Wrap. Fully bypasses shell expansion (globs, `$()`, backticks). Aliases only protect against globs; this is the complete solution.
- [ ] `--print` flag — generate command and print to stdout without executing. Implies force-cmd. Composability primitive for scripting, clipboard, shell widgets. Build alongside mode system (needs same input-parsing infra). Name `--print` not `--dry-run` (non-final steps still execute).
- [ ] Attached input: `--full` flag to send the complete content to the LLM without truncation (affects prompt preview only; the on-disk input file is always full).
- [ ] Attached input verbose lines — `Input file: {path} ({size})`, `Preview truncated: ...`. Empty pipes emit nothing.
- [ ] Contextual prompt sections — inject domain-specific context when CWD signals are present (e.g. if CWD listing contains `package.json`, include a brief section about Node project conventions like `<runner> run <script>` vs built-in subcommands). Keeps the base prompt general while giving the LLM targeted hints when they'd help most. Could also cover Makefile, Cargo.toml, pyproject.toml, etc.
