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
2. `none + !TTY + pipedInput` → fall through to `runSession` with empty prompt; pipe IS the prompt (existing behavior).
3. `ensureConfig` (wizard if needed). On first-run wizard completion, print `✓ wrap configured — run w again to start wrapping` via `chrome()`, exit 0. Don't auto-launch compose.
4. `none + TTY` → mount compose dialog → submitted text becomes `prompt` → fall through to `runSession`.

`createTempDir()` must run before compose mounts (Ctrl-G needs `$WRAP_TEMP_DIR`). Move its call above the compose-mount step.

---

## State

Existing follow-up tags get suffixed for clarity alongside the new initial-compose tags. Renames:
- `composing` → `composing-followup`
- `processing` → `processing-followup`

Updates landing across `src/session/state.ts`, `src/session/reducer.ts`, `src/session/session.ts`, `src/tui/response-dialog.tsx`.

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

Coordinator post-transition hook on entering `processing-user-prompt`: push initial user turn from `draft`, start pump loop. Mirrors how `processing-followup` does the equivalent for follow-up turns.

---

## Dialog

`composing-user-prompt` view:
- Top border: `compose` pill, left-aligned. No risk pill.
- Left border: low-risk blue gradient.
- Body: TextInput fills the dialog. No command fold, no explanation, no plan, no output slot.
- Bottom hint: `⏎ to send  |  ctrl+G to edit in <Editor>  |  Esc to exit`. Hides the `ctrl+G` segment when no editor resolved (see §Editor).

Width: standard dialog widening rule. Height: TextInput starts at 3 visible rows, grows with content up to `Math.max(3, terminalRows - 6)`, then vertical scroll keeps cursor in view.

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
- `row` / `col` getters — derived from `text.slice(0, offset)`.

Existing methods (`insert`, `backspace`, `wordLeft`, `killToEnd`, etc.) already operate on the flat string and need no change. `killToEnd` deletes to end-of-buffer (existing semantics) — adequate for both modes.

### Submit vs newline

`multiline: false` (default): plain Enter → `onSubmit`. `\n` is rejected by `insert` (paste containing `\n` strips them, matches existing single-line assumption).

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

Soft cap 256KB. On overflow (typed, pasted, edited via Ctrl-G), truncate at the last complete UTF-8 code point ≤ 256KB and show `paste truncated — for large input, pipe with cat file | w` in the bottom border. Banner clears on next keystroke.

### Paste policy (multiline only)

Bracketed paste bytes: normalize `\r\n` → `\n`, strip NUL and C0 controls except `\t` / `\n`. Other bytes verbatim (UTF-8). Paste arrives as one atomic insert; cursor lands at paste end.

Paste safety:
- 5s timeout after `\x1b[200~` with no matching `\x1b[201~` → flush accumulated, reset.
- Esc during paste → discard partial, reset, return to editing.
- Accumulator bounded at 256KB.

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

Parser sits between Node's `stdin.on('data', …)` and Ink. Accumulate a small byte buffer per chunk: scan for complete CSI sequences (terminator after CSI start), emit matched modified-key events to the TextInput, forward unmatched bytes onward to Ink. Handles split-across-chunk sequences. Two CSI shapes:

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

Terminal-owning editors: unmount Ink before spawn (editor needs the TTY); remount after exit. The keyboard-protocol modes pop via the standard unmount teardown.

GUI editors (`gui: true`): keep Ink mounted, set the TextInput's `editingExternal` prop (see §TextInput), spawn editor. When `proc.exited` resolves, clear the prop and update the buffer.

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

TDD per project rule. Unit-test the kitty / modifyOtherKeys parser against fixture byte strings. Integration-test the `main.ts` branch with a mock TTY.
