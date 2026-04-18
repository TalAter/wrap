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

- **Trigger:** no CLI args AND stdin is a TTY. Piped stdin always skips compose — pipe IS the prompt.
- **Single-shot.** One invocation = one submitted prompt. No REPL loop — conversational mode is a separate future feature.
- **Multiline + paste-safe editor.** Plain Enter submits; multiple newline mechanisms cover terminals without modified-key support. Bracketed paste keeps embedded newlines literal.
- **External editor handoff.** Ctrl-G opens the user's `$EDITOR` with the current buffer; saved text returns to compose.
- **Handoff to round.** Submit morphs the dialog in place into thinking → `confirming` (or answer). Same shell as [[follow-up]].
