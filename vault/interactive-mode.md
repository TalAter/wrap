---
name: interactive-mode
description: Free-text prompt area when w is run with no args on a TTY
Source: src/session/session.ts, src/tui/response-dialog.tsx, src/tui/text-input.tsx, src/core/editor.ts
Last-synced: (head)
---

# Interactive mode

> **Status:** Implemented.

When `w` runs with no user prompt on a TTY, Wrap enters a multiline compose dialog. The user drafts the prompt without shell quoting or single-line constraints; submit morphs the dialog in place through thinking → confirming (or answer), the same shell as [[follow-up]].

## Trigger

- CLI input empty AND stdin is a TTY. `main.ts` falls through to `runSession(prompt: "")`.
- No TTY + nothing piped → `--help` as before.
- No TTY + piped input → `runSession(prompt: "")`, pipe IS the prompt (unchanged).
- First-run wizard completion on an interactive invocation prints `✓ wrap configured — run w again to start wrapping` and exits 0 rather than auto-launching compose.

Compose lives inside `runSession`: empty prompt + TTY seeds the initial state as `composing-interactive` instead of `thinking`, and the transcript stays empty until submit so the LLM never sees a context blurb with no user request attached.

## State machine

Three new tags peer with the existing dialog tags (see [[session]]):

- `composing-interactive { draft }` — user typing. Submit → `processing-interactive`. Esc → `exiting{cancel}`. Ctrl-G → `editor-handoff`.
- `processing-interactive { draft, status? }` — first LLM round in flight. Esc → `composing-interactive` (draft preserved, in-flight LLM aborted). `loop-final command` → `confirming` (any risk, because the dialog is already mounted — low-risk auto-exec only applies from `thinking`). Reply/exhausted exit normally.
- `editor-handoff { origin, draft, response?, round? }` — transient state while a terminal-owning editor holds the TTY. Excluded from `isDialogTag` so Ink unmounts. On `editor-done` the reducer restores the origin (composing-interactive / composing-followup / editing) with the new or preserved draft.

Events added: `submit-interactive { text }`, `enter-editor { draft }`, `editor-done { text: string | null }`.

### Why a separate bootstrap event

`submit-interactive` is distinct from `submit-followup` because the coordinator handles them differently. The interactive submit bootstraps an empty transcript and rebuilds the scaffold with the draft (so `initialUserText` carries the proper user-request framing), whereas `submit-followup` appends to an existing transcript where the candidate-command turn is already the last message.

### Why `editor-handoff` lives in the reducer

GUI editors (VS Code, Cursor, Sublime) fork and detach from the TTY; Ink stays mounted, the dialog runs the spawn in a local `useEffect`, and the TextInput's `editingExternal` prop renders the "Save and close editor to continue..." frame. Terminal-owning editors (vim, nano, hx) own the TTY — Ink must unmount before the spawn or the child fights the reconciler over stdin. A dialog-local effect cannot orchestrate its own unmount, so the coordinator has to own that path. Making `editor-handoff` a reducer tag keeps the state transition observable and gives the coordinator a single post-transition hook to drive spawn → await → `editor-done`.

### Cancel exits 0

User-initiated abort (Esc / Ctrl-C in any compose / confirming / editing state) returns 0 from the session now. `exhausted`, `blocked`, `error` still return 1 — those are limits or system failures, not user choices.

## Dialog

Rendered through the shared `ResponseDialog` shell. The compose view uses a `compose` pill (left-aligned top border) and the low-risk blue gradient; no risk pill. The body is a multiline `TextInput` (see [[tui]]) that fills the dialog and caps visible rows at `terminalRows - DIALOG_CHROME_ROWS`, scrolling to keep the cursor in view for long drafts. Bottom bar: `INTERACTIVE_COMPOSE_ACTIONS` via the shared `ActionBar` (`⏎ send`, `ctrl+G edit in <Editor>` when an editor resolves, `Esc cancel`).

Paste truncation banner renders *under the input box* (not in the border) so it stays close to the content that was trimmed. Clears on the next keystroke.

Placeholder is a random pick from a curated set (`list all markdown files here`, `delete all .DS_Store files in this project`, `add .env to git ignore`). Static within a given empty-buffer state; a fresh pick fires each time the buffer goes from non-empty back to empty.

## TextInput

`src/tui/text-input.tsx` exposes a discriminated union: `multiline?: false` keeps the existing single-line behavior (API-key entry, edit-command, pre-slice-10 follow-up); `multiline: true` opts into newline insertion, soft-wrap, and windowed scroll via `maxRows`. `editingExternal?: boolean` is orthogonal — swaps the buffer for the "Save and close editor..." frame and gates input/paste off during external-editor spawns.

### Submit vs newline (multiline)

Plain Enter submits (empty buffer is a no-op). Newline inserts on:

- **Shift+Enter** via kitty CSI-u (Ink 7's `parseKeypress` surfaces this as `{ return: true, shift: true }`).
- **Ctrl+J** — kitty: `{ ctrl: true, input: "j" }`; non-kitty: raw `\n` with `key.return === false`. Both handled.
- **Backslash + Enter** — buffer ends with `\` and Enter is pressed; strip the `\`, insert `\n`.
- **Inside bracketed paste** via Ink 7's `usePaste`, which emits the pasted string atomically.

Single-line mode strips `\n` from multi-char input and from pastes so a terminal dropping newlines into a single-field input can't smuggle them through.

### Paste policy

`usePaste` owns bracketed paste — it auto-toggles `\x1b[?2004h` on mount, emits the paste atomically, and buffers across stdin chunks. Inside the handler we only:

1. Sanitize: `\r\n` → `\n`, drop other control bytes (keep tab + LF).
2. Run the sanitized string through `clampBufferSize` (256KB cap, UTF-8 boundary-safe).
3. Fire `onTruncate` if the cap was hit — parent renders the banner.

### Why 256KB

Above this, Ink reflow starts freezing per keystroke even on fast terminals. The soft cap is enforced at every source that can grow the buffer: `usePaste`, multi-char `useInput` bursts, and the external-editor return handler. Buffer math stays trivial relative to Ink's own reflow cost at that size, so no memoization.

## Keyboard protocol

**Ink 7 does the heavy lifting.** Its `parseKeypress` parses kitty CSI-u natively; `usePaste` owns bracketed paste. What we own:

- **Kitty enable/disable bytes** (`\x1b[>1u` on compose mount, `\x1b[<u` on unmount). Ink does not write these; without them most terminals drop Shift+Enter's shift bit. Registered with the exit-teardown registry so a SIGINT during compose doesn't leave the terminal in the extended keyboard protocol.
- **Mount-order invariant:** Ink's existing mount useEffect drains stdin before our kitty-enable useEffect fires, so buffered pre-mount keystrokes and in-flight paste CSI sequences are handled before the protocol toggle lands.

Ctrl+J + `\` + Enter fallbacks cover terminals without kitty (tmux without `extended-keys on`, etc.) with no protocol detection.

## External editor (Ctrl-G)

`src/core/editor.ts` exposes `resolveEditor()` (module-cached first-call-wins) and an `EDITORS` record keyed by basename. Resolution order: `$VISUAL` → `$EDITOR` → sweep known editors via `Bun.which` in declaration order, short-circuit on first hit.

GUI editors (VS Code, Cursor, Sublime, …) carry a `waitFlag` and `gui: true`; the spawn is dialog-local and bypasses the reducer. Terminal-owning editors (vim, nvim, nano, emacs, hx, helix, micro, vi) block naturally and go through `editor-handoff`. Unknown resolved editors fall back to the terminal-owning path — better to surface the mismatch than silently drop the buffer because a detached GUI editor exited instantly.

Temp file lives at `$WRAP_TEMP_DIR/prompt.md` (lazy-created per invocation). Exit-code policy: `0 + non-empty file` replaces the buffer; `0 + empty file` and any non-zero exit preserve the current buffer.

Ctrl-G is wired into three origins in v1 — `composing-interactive`, `composing-followup`, `editing` — all using the same `editor.ts` module, the same `editingExternal` TextInput prop, and the same GUI vs terminal-owning dispatch. Hint bars hide the `ctrl+G` item when nothing resolves.

### Terminal-owning handoff sequence

When `enter-editor` fires for a terminal-owning editor, the coordinator:

1. Ink is already unmounting (editor-handoff isn't a dialog tag).
2. Explicitly drops raw mode — Ink's unmount does not always clear it, and a raw-mode TTY inherited by the editor child produces wedged input.
3. Kitty disambiguate mode is popped by the compose useEffect cleanup; no extra write here.
4. `Bun.spawn` the editor with stdio `inherit`; await `proc.exited`.
5. Read temp file per the exit-code rules, dispatch `editor-done { text }`. Reducer transitions back to the origin; Ink remounts and re-applies protocol modes on compose mount.

## Logging + discoverability

`LogEntry.input_source: "argv" | "pipe" | "tui"` records how the prompt arrived. Absent on legacy entries — consumers should default to `"argv"`. Set by `main.ts` from the input type; the coordinator overrides to `"tui"` when `submit-interactive` fires. Verbose mode additionally echoes the submitted prompt line-by-line through the notification bus (flushes on teardown).

`--help` (both plain and styled) gains an Examples block above Commands so the bare `wrap` form is discoverable.

## Decisions

- **Extend `TextInput` with `multiline` prop, don't fork a new component.** Cursor stays string-based; existing single-line call sites pass no prop and behave as today.
- **State tag names use `-followup` / `-interactive` suffixes symmetrically.** Each tag is a self-contained shape per [[session]] convention.
- **Event name `submit-interactive` parallels `submit-followup`.** The coordinator distinguishes bootstrap (empty transcript, rebuild scaffold) from append (existing transcript) at submit time, not via tag inspection.
- **Cancel exits 0.** User-initiated abort is graceful, not a failure.
- **`editingExternal` is a TextInput prop, not session state.** Three real consumers in v1 all gain Ctrl-G wiring; per-site cost is one `useKeyBindings` entry + the GUI spawn effect.
- **Ctrl+J + `\`+Enter as guaranteed fallbacks.** Work in every terminal without protocol detection.
- **256KB buffer cap.** Above this Ink reflow freezes per keystroke.
- **Static placeholder from a curated set.** Motion while typing distracts; fresh pick only when the buffer empties.
- **Skip Ink unmount for GUI editors.** They don't take the TTY — unmounting is pure flicker.
- **Lean on Ink 7's `parseKeypress` + `usePaste`; no custom stdin parser.** Kitty CSI-u is handled natively; we only write the enable/disable bytes.
- **Drop modifyOtherKeys (`\x1b[>4;2m`).** Ink's parser doesn't match the `CSI 27;m;code~` shape so enabling it yields no usable events. Kitty + Ctrl+J + `\`+Enter is sufficient coverage.
- **Drop Ctrl+X Ctrl+E chord from v1.** Would be the first keyboard chord in the codebase for a muscle-memory alias of Ctrl+G. Ctrl+G already works and is in the bar.
- **Truncation banner under the input, not in the border.** Close to the content that got trimmed, doesn't fight the spinner slot, clears on next keystroke.
