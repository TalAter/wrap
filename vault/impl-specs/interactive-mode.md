# Interactive mode

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

`createTempDir()` runs before `runSession` (as today — see `main.ts`), so `$WRAP_TEMP_DIR` is available when Ctrl-G fires inside compose.

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

Coordinator post-transition hook on entering `processing-user-prompt`: push a `user` transcript turn carrying `draft` as its content (see `src/core/transcript.ts` for turn shape), reset `loopState.budgetRemaining`, start the pump loop via `startPumpLoop`. Mirrors how `processing-followup` bootstraps follow-up turns.

---

## Dialog

Both new tags render through the existing response-dialog shell.

### `composing-user-prompt` view

- Top border: `compose` pill, left-aligned. Build using `PillSegment` (`src/tui/pill.tsx`) — same primitive used by the wizard breadcrumbs. No risk pill.
- Left border: low-risk blue gradient via `getRiskPreset("low").stops` (`src/tui/risk-presets.ts`).
- Body: TextInput (`multiline: true`) fills the dialog. No command fold, no explanation, no plan, no output slot.
- Bottom hint: `⏎ to send  |  ctrl+G to edit in <Editor>  |  Esc to exit`. Hides the `ctrl+G` segment when no editor resolved (see §Editor).

### `processing-user-prompt` view

Same dialog shell. TextInput switches to `readOnly` rendering the submitted `draft`. No hint; bottom border shows the status spinner (same pattern as `processing-followup` — see `response-dialog.tsx` `bottomStatus` derivation).

### Keys and sizing

`Ctrl+X Ctrl+E` is an alias for `Ctrl+G` (bash/zsh readline convention). Only `Ctrl+G` is shown in the hint. Implementation: track "saw Ctrl+X within last 500ms" in a local ref; if the next keystroke is Ctrl+E within that window, dispatch the same action as Ctrl+G; otherwise clear the ref and let the key fall through.

Width: standard dialog widening rule (see [[tui]]). Height: TextInput starts at 3 visible rows, grows with content up to `Math.max(3, terminalRows - DIALOG_CHROME_ROWS)`, then vertical scroll keeps cursor in view. `DIALOG_CHROME_ROWS = 6` (2 border + 2 padding + 1 pill/spacer + 1 hint).

Hint pulls the editor display name from the `EDITORS` record (see §Editor handoff) — unknown → basename. If the resolved hint overflows, fall back to `⏎ send  |  ctrl+G edit  |  Esc exit`.

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

`multiline: true`: plain Enter (`\r` outside a paste block, no trailing `\`) → `onSubmit`. Newline inserted on:
- **Shift+Enter** — via kitty / modifyOtherKeys (see §Keyboard protocol).
- **Ctrl+J** (`0x0A`) — universal fallback.
- **Backslash-Enter** — buffer ends with `\` and Enter is pressed; strip the `\`, insert `\n`.
- **Inside bracketed paste** — newlines between `\x1b[200~` and `\x1b[201~` are literal.

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

Bracketed paste bytes: normalize `\r\n` → `\n`, strip NUL and C0 controls except `\t` / `\n`. Other bytes verbatim (UTF-8). Paste arrives as one atomic insert; cursor lands at paste end.

Paste safety lives in the raw-stdin parser (see §Keyboard protocol) which owns the paste-mode flag:
- 5s timeout after `\x1b[200~` with no matching `\x1b[201~` → flush accumulated as if a close marker arrived, reset paste-mode flag.
- Esc keypress while paste-mode is active → discard accumulator, reset flag, forward Esc to Ink.
- Accumulator bounded at 256KB; further bytes flush-and-reset.

---

## Keyboard protocol

On compose mount:
- `\x1b[>1u` — kitty disambiguate push.
- `\x1b[>4;2m` — xterm modifyOtherKeys level 2.
- `\x1b[?2004h` — bracketed paste.

On unmount:
- `\x1b[<u` — kitty pop.
- `\x1b[>4m` — modifyOtherKeys reset.
- `\x1b[?2004l` — bracketed paste off.

`ensureExitGuard()` in `src/core/spinner.ts` is currently file-private. Export it (or a sibling `registerExitTeardown(bytes)`) and generalize so multiple subscribers can register teardown bytes; teardown writes pop bytes before Ink's restore.

Mount order: stdin drain (1024 bytes per [[tui]]) FIRST, then write protocol-enable bytes. Drain ahead of enable prevents an in-flight paste's `\x1b[200~` from being eaten.

Parser is a stdin middleware. Ink 7 installs its own `data` listener on `process.stdin`; a second listener in parallel breaks byte ordering. Approach: on compose mount, detach Ink's stdin reader (keep a handle), install our parser as the sole listener, and have the parser forward everything it doesn't match to Ink's reader as if it arrived directly. On unmount, restore Ink's listener. Rendered in code via Node `stdin.off(...)` + `stdin.on(...)` around the compose lifecycle.

The parser maintains a small byte buffer per chunk: scan for complete CSI sequences (terminator after CSI start), emit matched modified-key events directly to the TextInput (via a ref-based emitter the compose dialog passes down), forward unmatched bytes to Ink. Handles split-across-chunk sequences by holding the trailing partial for the next chunk. Tracks a paste-mode flag between `\x1b[200~` and `\x1b[201~` (see §TextInput paste safety).

Two CSI shapes for modified keys:

- Kitty: `CSI keycode ; modifier u` — regex `/\x1b\[(\d+);(\d+)u/`, groups `(keycode, modifier)`.
- modifyOtherKeys: `CSI 27 ; modifier ; keycode ~` — regex `/\x1b\[27;(\d+);(\d+)~/`, groups `(modifier, keycode)`.

Keycode 13 = Enter. Modifier `1 + shift(1) + alt(2) + ctrl(4) + super(8)` → mod 2 = Shift, mod 5 = Ctrl.

tmux: silent. `\`+Enter / Ctrl+J / paste cover the case without `extended-keys on`.

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

Temp file via `createTempDir()` at `$WRAP_TEMP_DIR/prompt.md`. Write buffer → spawn (`Bun.spawn`, stdio `inherit`, `await proc.exited`) → on exit read file, trim trailing `\n`, delete temp file → update buffer.

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

---

## Implementation slices

1. **State tag renames + cancel→0:** rename `composing` → `composing-followup`, `processing` → `processing-followup` across `state.ts`, `reducer.ts`, `session.ts`, `response-dialog.tsx`. Rewire `cancel` outcome to exit 0. Reducer tests stay green (rename only).
2. **Cursor line helpers:** add `upLine`, `downLine`, `row`, `col` to `Cursor`. Unit-test against multiline strings.
3. **TextInput `multiline` prop + `editingExternal`:** discriminated-union prop; Enter behavior branched; `\n` rejected on insert when single-line. Soft-wrap render + cursor visual. New TextInput tests for: Shift+Enter inserts `\n`, Ctrl+J inserts `\n`, backslash-Enter conversion, paste `\n` preserved/stripped, plain Enter submits in both modes, `editingExternal` disables input + renders label. Existing tests stay green.
4. **Trigger + new tags:** main.ts reorder; add `composing-user-prompt` + `processing-user-prompt` to state union, reducer, `isDialogTag`. New event `submit-user-prompt`. Coordinator hook on entering `processing-user-prompt`: push initial user turn from `draft`, start pump loop. Compose dialog renders TextInput with `multiline`. Reducer-level unit tests for both new tags' transitions.
5. **Bracketed paste:** enable + parse; CRLF + C0 strip; 5s + Esc + 256KB safety nets.
6. **Kitty + modifyOtherKeys:** raw-stdin parser; push/pop via exposed/generalized `ensureExitGuard`; drain-before-enable ordering.
7. **Placeholder:** sample set; static random pick on mount; hide on keystroke or paste-start.
8. **Editor handoff:** `src/core/editor.ts` (`resolveEditor`, `EDITORS`); Ctrl-G; temp file via `createTempDir`; terminal-owning unmount path; GUI `editingExternal` path.
9. **Follow-up TextInput swap:** flip `multiline: true` on the existing follow-up TextInput call site. State tag unchanged (already renamed in slice 1).
10. **Discoverability + logging:** Examples block in `--help`; `input_source` on `LogEntry`; `--verbose` prompt-trace echo on teardown.

TDD per project rule. Unit-test the kitty / modifyOtherKeys parser against fixture byte strings. Unit-test `clampBufferSize` (UTF-8 boundary, below-cap passthrough, above-cap truncation). Integration-test the `main.ts` branch with a mock TTY — if no mock-TTY harness exists today, build one in slice 4 (smallest touch: a `StdinSource`-like seam parallel to `src/core/piped-input.ts` for the TTY path).
