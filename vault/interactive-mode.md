---
name: interactive-mode
description: Free-text compose dialog when w is run with no args on a TTY
Source: src/session/session.ts, src/tui/response-dialog.tsx, src/tui/text-input.tsx, src/core/editor.ts
Last-synced: 0a22f2a
---

# Interactive mode

When `w` runs with no user prompt on a TTY, Wrap opens a multiline compose dialog instead of help. The user drafts without shell quoting; submit morphs the dialog in place into thinking → confirming (or answer), sharing the same shell as [[follow-up]]. No TTY + nothing piped still falls through to `--help`; piped input is unchanged.

Compose lives inside the normal session loop. Empty prompt + TTY seeds compose state directly so the transcript stays empty until submit — the LLM never sees a context blurb without a user request attached.

## State machine

Three tags peer with the existing dialog tags (see [[session]]): a compose tag while the user types, a processing tag covering the first LLM round (Esc cancels and restores the draft), and a transient editor-handoff tag for terminal-owning external editors. Submit always lands at confirming, even for low-risk commands — the dialog is already mounted, so the auto-exec shortcut doesn't apply.

Submit is a distinct event from follow-up submit. Interactive submit bootstraps an empty transcript and frames the draft as the user request; follow-up appends to a transcript whose last turn is already a candidate command. The coordinator handles them differently at submit time, not by inspecting tags.

User-initiated abort (Esc / Ctrl-C in any compose, confirming, or editing state) returns 0 — graceful, not a failure. `exhausted`, `blocked`, and `error` still return 1.

## Dialog

Rendered through the shared response-dialog shell with a compose pill (no risk badge) and the low-risk gradient. The body is a multiline TextInput sized to the terminal, with a windowed scroll so long drafts keep the cursor visible. Truncation banner for over-cap pastes renders under the input — close to the trimmed content, doesn't fight the spinner slot, clears on next keystroke. Placeholder rotates from a curated set; a fresh pick fires only when the buffer empties.

## Multiline TextInput

Single component, multiline opt-in. Single-line mode strips newlines from multi-char input and pastes so a misbehaving terminal can't smuggle them through. In multiline, plain Enter submits; newline insertion comes from Shift+Enter (kitty CSI-u), Ctrl+J, trailing-backslash + Enter, or bracketed paste. Ctrl+J and `\`+Enter are guaranteed fallbacks — every terminal handles them with no protocol detection.

Bracketed paste goes through Ink 7's `usePaste` (atomic, buffered across stdin chunks). The handler sanitizes line endings, drops other control bytes, and clamps to a 256KB buffer cap — above that, Ink reflow freezes per keystroke. The cap is enforced at every source that can grow the buffer.

## Keyboard protocol

Ink 7's `parseKeypress` and `usePaste` cover kitty CSI-u and bracketed paste natively. Wrap only writes the kitty enable/disable bytes (Ink doesn't), registered with the exit-teardown registry so a SIGINT during compose can't leave the terminal in an extended protocol mode. Ink's stdin drain runs before the protocol toggle so buffered pre-mount bytes are handled before the switch.

## External editor (Ctrl-G)

Resolution order: `$VISUAL` → `$EDITOR` → sweep known editors. Wired into compose-interactive, compose-followup, and edit-command, all using one editor module.

GUI editors (VS Code, Cursor, Sublime) carry a wait flag and don't take the TTY — the spawn is dialog-local, Ink stays mounted, the input renders a "save and close" frame. Terminal-owning editors (vim, nano, hx, …) own the TTY — Ink must unmount before the spawn or the child fights the reconciler over stdin. A dialog-local effect can't orchestrate its own unmount, so the coordinator owns the path: `editor-handoff` is a reducer tag, excluded from dialog tags so Ink unmounts; the coordinator drops raw mode (Ink's unmount doesn't always clear it), spawns, awaits, then dispatches `editor-done` and the reducer restores the origin tag with the new draft. Unknown editors fall back to the terminal-owning path — better to surface a mismatch than silently drop the buffer because a detached GUI editor exited instantly.

Exit policy: zero exit + non-empty file replaces the buffer; everything else preserves it.

## Logging

Log entries record how the prompt arrived (argv / pipe / tui). Verbose mode echoes the submitted prompt through the notification bus on teardown. `--help` carries an Examples block so the bare `wrap` form is discoverable.

## Decisions

- **Multiline as a TextInput prop, not a fork.** Existing single-line call sites pass nothing and behave as before.
- **Cancel exits 0.** User-initiated abort is graceful.
- **External-editor flag is a TextInput prop, not session state.** Multiple consumers wire Ctrl-G with one effect each.
- **Ctrl+J + `\`+Enter as guaranteed fallbacks.** Work in every terminal without protocol detection.
- **256KB buffer cap.** Above this, Ink reflow freezes per keystroke.
- **Static placeholder.** Motion while typing distracts; fresh pick only when buffer empties.
- **Skip Ink unmount for GUI editors.** They don't take the TTY — unmounting is pure flicker.
- **Lean on Ink 7's `parseKeypress` + `usePaste`.** Kitty CSI-u is handled natively; we only own the enable/disable bytes.
- **Truncation banner under the input, not in the border.** Close to trimmed content, doesn't fight the spinner slot.
