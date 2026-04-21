# Interactive mode

> **Note on drift from main.** Since this spec was first drafted (c2f979f / 3eb95b6), main picked up: ActionBar + useKeyBindings consolidation in ResponseDialog (25e5da0, 0f71703, fbdf422), Round.attempts[] log shape (e925b2d, orthogonal here), and confirmation that Ink 7 ships `usePaste` + kitty-aware `parseKeypress`. The spec below has been updated to reflect all three — the main simplification is §Keyboard protocol, which no longer describes a custom stdin parser.

> When `w` runs with no positional input on a TTY, open a multiline TUI composer. User types the prompt without shell quoting, brace expansion, command substitution, or single-line constraints. On submit, the dialog morphs in place through thinking → confirming (or answer), same as follow-up.

## Motivation

Today `w` with no args prints `--help`. Passing natural language through argv collides with the shell: `$(...)` expands, `{a,b,c}` expands, quotes have to be escaped, multiline is impossible. Interactive mode bypasses argv — the prompt is captured by Wrap, not the shell, so every character is literal.

---

## Trigger

Launch when:
- Positional input is empty after modifier-flag strip (`input.type === "none"`).
- `process.stdin.isTTY === true`.

Subcommand flags (`--help`, `--version`, `--log`) short-circuit before this check. Modifier flags (`--verbose`, `--model`, `--no-animation`) are stripped first, so `w --verbose` enters interactive mode.

`none + !TTY` keeps printing `--help`. `w </dev/null` on first run prints help, not the wizard.

---

## Main-flow order

`src/main.ts`:

1. `none + !TTY + !pipedInput` → `--help`, exit.
2. `none + !TTY + pipedInput` → call `runSession(prompt="")`; pipe IS the prompt (existing behavior).
3. `ensureConfig` (wizard if needed). On first-run wizard completion, print `✓ wrap configured — run w again to start wrapping` via `chrome()`, exit 0. Don't auto-launch compose.
4. `none + TTY` → call `runSession(prompt="")`. The compose dialog is a state *inside* the session, not a pre-step.

Compose lives inside `runSession`: when the initial `prompt` is empty AND `process.stdin.isTTY`, the session's initial state is `composing-user-prompt` instead of today's `thinking`. User types, dispatches `submit-user-prompt`, the reducer transitions to `processing-user-prompt`, and the coordinator hook (see §State) bootstraps the transcript with `draft` and starts the pump loop. Compose mount, submit, and handoff are all expressed through the state machine — no second Ink lifecycle outside `runSession`.

`$WRAP_TEMP_DIR` is created lazily via `ensureTempDir()`. The Ctrl-G editor handoff calls `ensureTempDir()` itself before writing `prompt.md`, so compose works even when no shell has been spawned yet.

---

## State

Existing follow-up tags get suffixed for clarity alongside the new initial-compose tags. Renames:
- `composing` → `composing-followup`
- `processing` → `processing-followup`

Renames + new tag additions + new event all land across `src/session/state.ts`, `src/session/reducer.ts`, `src/session/session.ts`, `src/tui/response-dialog.tsx`.

New event `submit-user-prompt { text: string }`. Distinct from `submit-followup` because the coordinator handles them differently: `submit-user-prompt` bootstraps the very first user turn from empty transcript; `submit-followup` appends to an existing transcript.

New tag `composing-user-prompt`:

- Shape: `{ tag: "composing-user-prompt"; draft: string }`.
- `submit-user-prompt` → `processing-user-prompt`.
- `key-esc` → `exiting { kind: "cancel" }`.
- `draft-change` → updates `draft`.
- Add to `isDialogTag()`.

New tag `processing-user-prompt` (mirror of `processing-followup` for the first round):

- Shape: `{ tag: "processing-user-prompt"; draft: string; status?: string }`.
- `key-esc` → `composing-user-prompt` (preserves draft); coordinator aborts in-flight LLM round.
- `loop-final command` → `confirming` (always — dialog is open, mirror `processing-followup`; no auto-exec for low-risk).
- `loop-final answer` → `exiting { kind: "answer" }`.
- `loop-error` → `exiting { kind: "error" }`.
- `notification chrome` → updates `status`.
- Add to `isDialogTag()`.

Coordinator post-transition hook on entering `processing-user-prompt`: push a `user` transcript turn carrying `draft` as its content (see `src/core/transcript.ts` for turn shape), reset `loopState.budgetRemaining = maxRounds`, call `startPumpLoop({ isInitialLoop: true, followupText: undefined })` (session.ts:217). Mirrors how `processing-followup` bootstraps follow-up turns (session.ts:146,178). The Round.attempts[] refactor (e925b2d) is internal to runner — doesn't change this bootstrap path.

---

## Dialog

Both new tags render through the existing response-dialog shell.

### `composing-user-prompt` view

- Top border: `compose` pill, left-aligned. Build using `PillSegment` (`src/tui/pill.tsx`) — same primitive used by the wizard breadcrumbs. No risk pill.
- Left border: low-risk blue gradient via `getRiskPreset("low").stops` (`src/tui/risk-presets.ts`).
- Body: TextInput (`multiline: true`) fills the dialog. No command fold, no explanation, no plan, no output slot.
- Bottom bar: shared `ActionBar` (`src/tui/action-bar.tsx`) with glyph+label items — `⏎ send`, `ctrl+G edit in <Editor>`, `Esc cancel`. Pattern mirrors existing `COMPOSE_HINT_ITEMS` in `src/tui/response-dialog.tsx`. Add a new `COMPOSE_USER_PROMPT_HINT_ITEMS` constant alongside it. Hide the `ctrl+G` item when no editor resolved (see §Editor). If the bar overflows inner width, ActionBar already handles compaction.

### `processing-user-prompt` view

Same dialog shell. TextInput switches to `readOnly` rendering the submitted `draft`. Bottom bar: `PROCESS_HINT_ITEMS` (reuse existing — `Esc to abort`); status spinner runs in the bottom border via `bottomStatus` derivation, same as `processing-followup`.

### Keys and sizing

Key routing uses the shared `useKeyBindings` hook (`src/tui/key-bindings.ts`) — NOT raw `useInput`. The compose dialog's bindings list is gated by `isActive: state.tag === "composing-user-prompt"`, matching the pattern already used for `editing` / `composing` / `processing` in `response-dialog.tsx`. Bindings: `escape` → `key-esc`, `{ key: "g", ctrl: true }` → open editor, `{ key: "j", ctrl: true }` → insert newline.

`Ctrl+X Ctrl+E` is an alias for `Ctrl+G` (bash/zsh readline convention). Only `Ctrl+G` is shown in the bar. Implementation: track "saw Ctrl+X within last 500ms" in a local ref; if the next keystroke is Ctrl+E within that window, dispatch the same action as Ctrl+G; otherwise clear the ref and let the key fall through.

Width: standard dialog widening rule (see [[tui]]). Height: TextInput starts at 3 visible rows, grows with content up to `Math.max(3, terminalRows - DIALOG_CHROME_ROWS)`, then vertical scroll keeps cursor in view. `DIALOG_CHROME_ROWS = 6` (2 border + 2 padding + 1 pill/spacer + 1 hint).

Bar items pull the editor display name from the `EDITORS` record (see §Editor handoff) — unknown → basename. ActionBar handles overflow compaction itself.

---

## TextInput

Extend the existing `src/tui/text-input.tsx` with an opt-in `multiline?: boolean` prop (default `false`). Keep `Cursor` string-based — multiline is just `text` containing `\n`. Existing single-line call sites (`editing` command, `composing-followup`, wizard API-key entry) pass no `multiline` prop and behave exactly as today.

Props (discriminated union):

```ts
type TextInputProps = { editingExternal?: boolean } & (
  | { readOnly: true; value: string }
  | (BaseEditable & ({ multiline?: false } | { multiline: true }))
);
type BaseEditable = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  masked?: boolean;  // single-line only — type-forbidden with multiline
};
```

### Cursor extensions

Stay string-based. Add derived helpers (pure functions of `text + offset`):
- `upLine()` / `downLine()` — move by logical line, snap column.
- `row` / `col` getters — logical row and column; `row = text.slice(0, offset).split("\n").length - 1`, `col = offset - lastIndexOf("\n", offset-1) - 1` (zero-based).

For rendering, the dialog also needs VISUAL row/col because logical rows soft-wrap inside `innerWidth`:
- `visualRow(innerWidth) = sum over lines[0..row-1] of max(1, ceil(stringWidth(line) / innerWidth)) + floor(stringWidth(lines[row].slice(0, col)) / innerWidth)`.
- `visualCol(innerWidth) = stringWidth(lines[row].slice(0, col)) mod innerWidth`.

Existing methods (`insert`, `backspace`, `wordLeft`, `killToEnd`, etc.) already operate on the flat string and need no change. `killToEnd` keeps existing semantics (deletes to end-of-buffer).

### Submit vs newline

`multiline: false` (default): plain Enter → `onSubmit`. `Cursor.insert` filters `\n` characters from the incoming string in this mode — doesn't throw, doesn't drop the whole string, just strips the newlines and inserts the rest. Preserves existing single-line paste behavior.

`multiline: true`: plain Enter (no trailing `\`) → `onSubmit`. Newline inserted on:
- **Shift+Enter** — via kitty protocol; surfaces to `useInput` as `key.shift && key.return` (Ink 7 parses kitty CSI-u natively — see §Keyboard protocol).
- **Ctrl+J** (`0x0A`) — universal fallback. Surfaces as `key.ctrl && input === "j"`.
- **Backslash-Enter** — buffer ends with `\` and Enter is pressed; strip the `\`, insert `\n`.
- **Inside bracketed paste** — newlines arrive literally inside `usePaste`'s atomic text argument (Ink 7 owns the paste channel).

Empty-buffer Enter is a no-op.

### `editingExternal` prop

Orthogonal to `multiline` and `readOnly`. When set: `useInput` is gated off, the value is hidden, the InputFrame renders a bordered centered-message box:

```
──────────────────────────────────────────────────────────────────────
|                Save and close editor to continue...                |
──────────────────────────────────────────────────────────────────────
```

Message text is fixed (`Save and close editor to continue...`). Used by Ctrl-G handoff (see §Editor handoff). Other features can use it for any external-edit case.

### Wrap and scroll (multiline only)

Soft-wrap long lines at dialog inner width. No horizontal scroll. Vertical scroll keeps the cursor on screen when logical+wrapped rows exceed available rows.

Cursor visual position on wrapped lines requires width-aware row/col computation — see §Cursor extensions.

### Buffer cap (multiline only)

Soft cap 256KB. Enforcement lives in one helper, `clampBufferSize(text): { value: string; truncated: boolean }`, called from every source that can grow the buffer: `Cursor.insert` (large paste), paste handler, editor-return handler. When `truncated === true`, show `paste truncated — for large input, pipe with cat file | w` in the bottom border. Banner clears on next keystroke. Truncation cuts at the last complete UTF-8 code point ≤ 256KB.

### Paste policy (multiline only)

Ink 7's `usePaste` hook (`src/tui/... via ink`) owns bracketed paste: auto-enables `\x1b[?2004h` on mount, auto-disables on unmount, emits the full pasted string atomically, and keeps paste bytes out of `useInput`. Ink also handles the CSI pending-across-chunks case and wraps a paste-in-progress across multiple stdin chunks.

What's left for us in the `usePaste` handler:
- Normalize `\r\n` → `\n`, strip NUL and C0 controls except `\t` / `\n`.
- Run the sanitized string through `clampBufferSize` before inserting.
- Cursor lands at paste end.

No custom 5s timeout, Esc-during-paste accumulator reset, or accumulator byte cap — Ink's parser owns the paste-mode flag and buffers until `\x1b[201~` arrives or stdin closes.

---

## Keyboard protocol

**Ink 7 does the heavy lifting.** `parseKeypress` (`ink/build/parse-keypress.js`) parses kitty CSI-u natively — Shift+Enter arrives in `useInput` as `{ return: true, shift: true }`, Ctrl+J as `{ ctrl: true }` with `input === "j"`, printable chars as `text`, all with Ink's own pending-across-chunks buffering (`createInputParser`). `usePaste` owns bracketed paste (see §TextInput Paste policy). No custom stdin parser needed.

What we still own:

**Kitty enable/disable bytes.** Ink does not write `\x1b[>1u` / `\x1b[<u` itself — without them, most terminals send Shift+Enter as plain `\r` and the shift bit is lost. On compose mount: drain stdin (1024 bytes per [[tui]]) then write `\x1b[>1u`. On unmount: write `\x1b[<u`. Bracketed paste enable/disable is handled by `usePaste` automatically — do not also send `\x1b[?2004h` ourselves.

Drop modifyOtherKeys. Ink's `parseKeypress` does not match the `CSI 27;m;code~` shape (`fnKeyRe` skips it), so enabling `\x1b[>4;2m` would produce no usable events. The Ctrl+J and `\`+Enter fallbacks cover terminals without kitty.

**Exit-guard teardown.** `ensureExitGuard()` in `src/core/spinner.ts` is currently file-private and registers a single teardown for the cursor-show sequence. Generalize it (export `registerExitTeardown(bytes)` or similar) so multiple subscribers can register pop bytes; compose registers `\x1b[<u` there. Teardown runs on SIGINT / crash before Ink's restore so a killed Wrap never leaves the terminal in kitty mode.

tmux: silent. Without `extended-keys on` kitty doesn't propagate through, but Ctrl+J / `\`+Enter / paste cover the case without any flag.

---

## Placeholder

Hardcoded set:
- `list all markdown files here`
- `delete all .DS_Store files in this project`
- `add .env to git ignore`

One random pick on compose mount, rendered static. No rotation, no fade. Hidden on first keystroke or paste-start. Returns a different pick when buffer becomes empty.

---

## Editor handoff (Ctrl-G)

New module `src/core/editor.ts`. Exports `resolveEditor()` (module-memoized per invocation) and a single `EDITORS` record:

```ts
type EditorMeta = { displayName: string; waitFlag?: string; gui?: boolean };
const EDITORS: Record<string, EditorMeta>;
// GUI — detach by default, need wait flag to block
// code:            { displayName: "VS Code",          waitFlag: "-w",     gui: true }
// code-insiders:   { displayName: "VS Code Insiders", waitFlag: "-w",     gui: true }
// cursor:          { displayName: "Cursor",           waitFlag: "-w",     gui: true }
// windsurf:        { displayName: "Windsurf",         waitFlag: "-w",     gui: true }
// codium:          { displayName: "VSCodium",         waitFlag: "-w",     gui: true }
// antigravity:     { displayName: "Antigravity",      waitFlag: "-w",     gui: true }
// subl:            { displayName: "Sublime Text",     waitFlag: "--wait", gui: true }
// atom:            { displayName: "Atom",             waitFlag: "--wait", gui: true }
//
// Terminal-owning — block naturally
// vim:    { displayName: "Vim" }
// nvim:   { displayName: "Neovim" }
// nano:   { displayName: "Nano" }
// emacs:  { displayName: "Emacs" }
// hx:     { displayName: "Helix" }
// helix:  { displayName: "Helix" }
// micro:  { displayName: "Micro" }
// vi:     { displayName: "Vi" }
```

Resolution at compose mount:
1. `$VISUAL` (trimmed)
2. `$EDITOR` (trimmed)
3. First available of `Object.keys(EDITORS)` via `Bun.which`, in declaration order.

Lookup key = `basename(resolved).replace(/\.exe$/i, "")` — strips directory and Windows `.exe` suffix before the `EDITORS` lookup. Handles `/usr/local/bin/code` → `code`, `C:\...\notepad.exe` → `notepad`.

`hasEditor = false` → hide `ctrl+G` segment from the bottom hint, don't register the handler. Unknown resolved editors (not in `EDITORS`) → render basename in the hint, no wait flag, treat as terminal-owning.

GUI editors without a known wait flag (e.g. `notepad++`, `gedit`) are omitted from `EDITORS` on purpose. Including them without a wait mechanism means Wrap reads an empty file because the editor forks instantly; better to fall back to the generic "unknown editor → terminal-owning" path, which at least surfaces the mismatch obviously.

Temp file via `ensureTempDir()` at `$WRAP_TEMP_DIR/prompt.md`. Write buffer → spawn (`Bun.spawn`, stdio `inherit`, `await proc.exited`) → on exit read file, trim trailing `\n`, delete temp file → update buffer.

Terminal-owning editors: the editor inherits stdio and needs the TTY in line mode, not raw mode. Ordering:

1. Unmount Ink.
2. Call `process.stdin.setRawMode(false)` explicitly.
3. Write keyboard-protocol pop bytes (kitty, modifyOtherKeys, bracketed paste — see §Keyboard protocol).
4. `Bun.spawn` the editor with stdio `inherit`; `await proc.exited`.
5. Remount Ink. Ink re-enters raw mode and re-applies the protocol modes as part of compose mount.

Step 2 is load-bearing. Ink's unmount does not always clear raw mode — the flag remains latched on `process.stdin`, and the child editor inherits a raw-mode TTY. Symptom: `vim` / `nano` receive no character-at-a-time input (or wedged escape sequences), display is broken until the user force-exits. Explicitly dropping raw mode after unmount guarantees the editor sees a normal line-discipline TTY. The re-enable on step 5 is handled by Ink itself on mount — do not call `setRawMode(true)` manually or it races Ink.

GUI editors (`gui: true`): keep Ink mounted. The compose dialog owns the editor lifecycle via a local `useEffect` — no new reducer event:

1. On Ctrl-G: write buffer to temp file; set local `editorOpen = true`; TextInput renders with `editingExternal={true}`.
2. `await Bun.spawn(...).exited`.
3. Read temp file, delete it, run through `clampBufferSize`, dispatch `{ type: "draft-change", text }` to update draft.
4. Clear `editorOpen`; TextInput returns to editable.

Keeps the reducer unaware of editor async flow — the side-effect is local to the dialog component.

Editor exit handling:
- Exit 0 + non-empty file → replace buffer.
- Exit 0 + empty file → keep current buffer.
- Non-zero exit → keep current buffer.

---

## Submit handoff

Submit dispatches `submit-user-prompt` → reducer transitions to `processing-user-prompt` → coordinator hook pushes the initial user turn from `draft` and starts the pump loop. The dialog stays mounted: TextInput renders read-only with the submitted draft; bottom-border spinner runs.

Verbose lines from startup buffer while the dialog is mounted, flush to scrollback on teardown (existing behavior).

When `--verbose` is on, echo the submitted prompt as a dim multi-line stderr block on teardown (using existing buffering of output mechanism).

---

## Exit codes

User-initiated cancel returns 0 from anywhere in the session. Pressing Esc or Ctrl-C in any compose / confirming / editing dialog state is a graceful abort, not an error.

Change in `src/session/session.ts` `finaliseOutcome`: `cancel` returns 0 (was 1). `exhausted`, `blocked`, `error` keep returning 1 — those are limit / environment / system failures, not user choices.

Esc:
- `composing-user-prompt` → `exiting { kind: "cancel" }`.
- `composing-followup` → unchanged (back to `confirming`).
- `processing-user-prompt` → `composing-user-prompt`, draft preserved, in-flight LLM aborted.
- `processing-followup` → unchanged (back to `composing-followup`).
- `confirming` / `editing` → unchanged outcome path; same `cancel` outcome now exits 0.

Ctrl-C: same routing as Esc in dialog states; exit 0.

---

## Pipe

Piped stdin keeps existing behavior: pipe IS the prompt, no TUI.

---

## Discoverability

`--help` (`src/subcommands/help.ts`, `renderPlain` + `renderStyled`) gains an Examples block above Commands:

```
  Examples:
    wrap copy the contents of my .env file to clipboard, mask any IP addresses
        wrap writes the shell command for your request and runs it after
        you confirm
    wrap
        launch interactive mode — compose a multiline prompt in a friendly
        editor
```

---

## Logging

`LogEntry` gets `input_source: "argv" | "pipe" | "tui"`. Default `"argv"` when absent. Set in `main.ts` before calling `runSession`, forwarded as a `runSession` option.

---

## Decisions

- **Extend `TextInput` with `multiline` prop, don't fork a new component.** Cursor stays string-based; existing single-line call sites pass no prop and behave as today.
- **New state tags `composing-user-prompt` + `processing-user-prompt`.** Symmetric with the renamed `composing-followup` + `processing-followup`. Each tag is a self-contained shape per [[session]] convention.
- **Cancel exits 0.** User-initiated abort is graceful, not a failure. Existing `cancel` outcome is rewired.
- **`editingExternal` is a TextInput prop, not session state.** Any input in the app can use it; not tied to compose.
- **Ctrl+J + `\`+Enter as guaranteed fallbacks.** Work in every terminal without protocol detection.
- **256KB buffer cap.** Above this, Ink reflow freezes per keystroke.
- **Static placeholder, no rotation.** Motion while typing distracts.
- **Skip Ink unmount for GUI editors.** They don't take the TTY — unmounting is pure flicker.
- **Lean on Ink 7's `parseKeypress` + `usePaste`; no custom stdin parser.** Ink 7 parses kitty CSI-u natively (Shift+Enter, Ctrl+letter, printable text field), and `usePaste` owns bracketed paste with atomic strings. A parallel stdin listener or detach-and-forward scheme would duplicate Ink's work and break byte ordering. We write only the kitty enable/disable bytes — the rest comes free.
- **Drop modifyOtherKeys (`\x1b[>4;2m`).** Ink's `parseKeypress` doesn't match `CSI 27;m;code~`, so enabling it yields no usable events. Kitty + Ctrl+J + `\`+Enter is sufficient coverage.
- **Bottom bar uses shared `ActionBar` + `useKeyBindings`.** Post-dates the original spec — `src/tui/response-dialog.tsx` consolidated onto these primitives in commit 25e5da0. Compose follows the same pattern; no fresh `useInput` hooks.

---

## Implementation slices

1. **State tag renames + cancel→0:** rename `composing` → `composing-followup`, `processing` → `processing-followup` across `state.ts`, `reducer.ts`, `session.ts`, `response-dialog.tsx`. Rewire `cancel` outcome to exit 0. Reducer tests stay green (rename only).
2. **Cursor line helpers:** add `upLine`, `downLine`, `row`, `col` to `Cursor`. Unit-test against multiline strings.
3. **TextInput `multiline` prop + `editingExternal`:** discriminated-union prop; Enter behavior branched via `useKeyBindings` entries (`{ key: "j", ctrl: true }`, shift+return, backslash-return); `\n` rejected on insert when single-line. Soft-wrap render + cursor visual. Paste via Ink's `usePaste` — sanitize + `clampBufferSize` on the emitted string. New TextInput tests for: Shift+Enter inserts `\n`, Ctrl+J inserts `\n`, backslash-Enter conversion, paste `\n` preserved/stripped, plain Enter submits in both modes, `editingExternal` disables input + renders label. Existing tests stay green.
4. **Trigger + new tags:** main.ts reorder; add `composing-user-prompt` + `processing-user-prompt` to state union, reducer, `isDialogTag`. New event `submit-user-prompt`. Coordinator hook on entering `processing-user-prompt`: push initial user turn from `draft`, start pump loop via `startPumpLoop` (session.ts:217), reset `loopState.budgetRemaining`. Compose dialog renders TextInput with `multiline` inside ResponseDialog using a new state-keyed render block alongside the existing `composing` / `processing` branch at response-dialog.tsx:355. Reducer-level unit tests for both new tags' transitions.
5. **Kitty enable/disable + exit-guard generalization:** write `\x1b[>1u` on compose mount (after stdin drain), `\x1b[<u` on unmount; generalize `ensureExitGuard` in `src/core/spinner.ts` to accept multiple teardown-byte subscribers; register `\x1b[<u` there. No custom parser — Ink 7's `parseKeypress` + `usePaste` cover everything. No modifyOtherKeys.
6. **Placeholder:** sample set; static random pick on mount; hide on keystroke or paste-start.
7. **Editor handoff:** `src/core/editor.ts` (`resolveEditor`, `EDITORS`); Ctrl-G via `useKeyBindings`; temp file via `ensureTempDir` (`src/fs/temp.ts`); terminal-owning unmount path; GUI `editingExternal` path.
8. **Follow-up TextInput swap:** flip `multiline: true` on the existing follow-up TextInput call site. State tag unchanged (already renamed in slice 1).
9. **Discoverability + logging:** Examples block in `--help`; `input_source` on `LogEntry`; `--verbose` prompt-trace echo on teardown.

TDD per project rule. Unit-test `clampBufferSize` (UTF-8 boundary, below-cap passthrough, above-cap truncation). Unit-test the backslash-Enter + Ctrl+J + Shift+Enter paths through TextInput's `useKeyBindings` bindings using `ink-testing-library`. Integration-test the `main.ts` branch with a mock TTY — if no mock-TTY harness exists today, build one in slice 4 (smallest touch: a `StdinSource`-like seam parallel to `src/core/piped-input.ts` for the TTY path).
