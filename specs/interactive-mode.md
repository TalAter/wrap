# Interactive Mode

**Status:** Future (TUI library selected: Ink — see `specs/tui-approach.md`)
**Date:** 2026-03-26

## Overview

When the user runs `wrap` or `w` with no arguments and stdin is a TTY, Wrap enters interactive mode — a free-text input area for composing prompts without shell quoting, escaping, or single-line constraints.

## Behavior

- **Trigger:** No arguments, stdin is a TTY. (Currently this shows help; interactive mode replaces that.)
- **Single-shot:** After the user submits, Wrap processes the prompt exactly as if it were passed as CLI arguments, then exits. No REPL loop.
- **Future:** A REPL/conversation mode may be added later as a separate feature (likely tied to threads).

## Input Area

- Multiline free-text editor. No quoting or escaping needed.
- **Submit:** Enter. **Newline:** Shift-Enter.
- **Ctrl-G:** Opens `$EDITOR` with the current input. On save and close, text returns to the prompt area for review before submitting. Empty/discarded file cancels.
- **Ctrl-C:** Cancels and exits.
- Prompt chrome (hints, decorations, logo) deferred to implementation — let the TUI lib inform what feels right.

## Output Rules

Since this is single-shot, no special handling needed. The TUI prompt collects input, then tears down. Execution proceeds identically to `w <prompt>` — command stdout goes to stdout, Wrap chrome to stderr, per existing rules.

## Open Questions

- **Piped stdin interaction:** When stdin is piped (`echo "context" | w`), should that be treated as the prompt text, as context for the prompt, or something else? Needs decision before implementation.

## TUI Library Requirements

This feature is the primary driver for choosing a TUI library. The library must support:

- Multiline text input with key rebinding (Enter vs Shift-Enter)
- External editor integration (Ctrl-G → `$EDITOR` → return text)
- Clean teardown before handing the terminal back to a child process
- Writing chrome to stderr or `/dev/tty` (not stdout)
