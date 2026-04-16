---
name: interactive-mode
description: Planned free-text prompt area when w is run with no args on a TTY
Source: (planned — no code yet)
Last-synced: c54a1a5
---

# Interactive mode

Planned. Not built.

When `w` runs with no user prompt on a TTY, Wrap enters a free-text input area. Compose a prompt without shell quoting, escaping, or single-line constraints.

## Design

- **Trigger:** no CLI args AND stdin is a TTY. Piped stdin does not trigger it.
- **Single-shot.** After submit, tear down the TUI, process text as CLI args, exit. No REPL loop — conversational mode is a separate future feature.
- **Multiline editor.** Enter submits, Shift-Enter inserts newline. Ctrl-G opens `$EDITOR` with current buffer; on save, text returns for review. Empty/discarded editor file cancels the handoff, not the session. Ctrl-C exits.
- **Output.** Single-shot means no special handling. TUI collects input, tears down, then normal stdout rules apply.

## Open questions

- **Piped stdin + no args:** `echo "context" | w` — treat piped text as the prompt (skip interactive mode). Entering a TUI on piped stdin is impossible anyway.
