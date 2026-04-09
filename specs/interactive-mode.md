# Interactive Mode

**Status:** Unbuilt. TUI library selected: Ink (see `specs/tui-approach.md`). The dialog TUI for confirmations exists; the no-arg entry TUI does not.

## Purpose

When `w` is run with no user prompt on a TTY, Wrap enters a free-text input area for composing a prompt without shell quoting, escaping, or single-line constraints. Today this path shows help — interactive mode replaces that.

## Design

- **Trigger:** no CLI args AND stdin is a TTY. Piped stdin does not trigger it (see Open Questions).
- **Single-shot:** after submit, Wrap tears down the TUI and processes the text exactly as if it had been passed as CLI args, then exits. No REPL loop — a conversational mode is a separate future feature, likely tied to threads.
- **Input area:** multiline editor. Enter submits, Shift-Enter inserts a newline. Ctrl-G opens `$EDITOR` with current buffer; on save the text returns to the prompt for review. Empty/discarded editor file cancels the editor handoff, not the session. Ctrl-C exits.
- **Output rules:** since it is single-shot, no special handling is needed. The TUI collects input, tears down, then execution proceeds under the normal stdout-is-useful-output rule — command stdout to stdout, chrome to stderr.

## Why single-shot first

Keeps the mental model identical to `w <prompt>`: the TUI is just an input method, not a new execution mode. Avoids entangling with thread/continuation design. A REPL can be layered on later without reworking this path.

## Constraints on the TUI library

Interactive mode is the primary driver for the TUI library choice. Requirements:

- Multiline text input with rebindable Enter vs Shift-Enter.
- External editor integration (suspend → `$EDITOR` → resume with updated buffer).
- Clean teardown before handing the terminal to a child process (the executed command may be interactive — vim, less, fzf).
- Never writes to stdout. All TUI paint goes to stderr or `/dev/tty`.

Ink satisfies these; see `specs/tui-approach.md` for the rationale.

## Open Questions

- **Piped stdin + no args:** `echo "context" | w` has no prompt and non-TTY stdin. Is the piped text the prompt, context for a prompt collected interactively, or an error? Decide before implementation. Current lean: treat as the prompt (skip interactive mode when stdin is piped, even with no args), because entering a TUI on piped stdin is impossible anyway.
- **Chrome inside the input area** (hints, logo, decorations): deferred until implementation — let the library inform what feels right.

## TODO

- Detect the no-args + TTY case in the entry path and route to interactive mode instead of help.
- Build the Ink input component (multiline, key bindings, `$EDITOR` handoff).
- Ensure teardown fully releases the terminal before the executed command runs.
- Resolve the piped-stdin open question.
- Tests: snapshot of the input component, a TTY-detection routing test, and an end-to-end test that submitted text reaches the query path identically to CLI args.
