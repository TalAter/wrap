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

Compose lives inside `runSession`: when the initial `prompt` is empty AND `process.stdin.isTTY`, the session's initial state is `composing-interactive` instead of today's `thinking`. User types, dispatches `submit-interactive`, the reducer transitions to `processing-interactive`, and the coordinator hook (see §State) bootstraps the transcript with `draft` and starts the pump loop. Compose mount, submit, and handoff are all expressed through the state machine — no second Ink lifecycle outside `runSession`.

`$WRAP_TEMP_DIR` is created lazily via `ensureTempDir()`. The Ctrl-G editor handoff calls `ensureTempDir()` itself before writing `prompt.md`, so compose works even when no shell has been spawned yet.

---

## State

Pre-step renames landed in commit a15630c (`composing` → `composing-followup`, `processing` → `processing-followup`, `_HINT_ITEMS` → `_ACTIONS`). See §Pre-step renames for the full list — historical reference, nothing to re-apply.

New event `submit-interactive { text: string }`. Add to the `AppEvent` union in `src/session/state.ts` alongside `submit-edit` / `submit-followup` / `draft-change`. Distinct from `submit-followup` because the coordinator handles them differently: `submit-interactive` bootstraps the very first user turn from empty transcript; `submit-followup` appends to an existing transcript.

New tag `composing-interactive`:

- Shape: `{ tag: "composing-interactive"; draft: string }`.
- `submit-interactive` → `processing-interactive`.
- `key-esc` → `exiting { kind: "cancel" }`.
- `draft-change` → updates `draft`.
- Add to `isDialogTag()`.

New tag `processing-interactive` (mirror of `processing-followup` for the first round):

- Shape: `{ tag: "processing-interactive"; draft: string; status?: string }`.
- `key-esc` → `composing-interactive` (preserves draft); coordinator aborts in-flight LLM round.
- `loop-final command` → `confirming` (always — dialog is open, mirror `processing-followup`; no auto-exec for low-risk).
- `loop-final answer` → `exiting { kind: "answer" }`.
- `loop-error` → `exiting { kind: "error" }`.
- `notification chrome` → updates `status`.
- Add to `isDialogTag()`.

Coordinator post-transition hook on entering `processing-interactive`: push a `user` transcript turn carrying `draft` as its content (see `src/core/transcript.ts` for turn shape), reset `loopState.budgetRemaining = maxRounds`, call `startPumpLoop({ isInitialLoop: true, followupText: undefined })` (defined in `src/session/session.ts`). Mirrors how the existing `submit-followup` hook bootstraps follow-up turns in the same file — grep for the `processing-followup` entry branch inside `dispatch`. The Round.attempts[] refactor (e925b2d) is internal to runner — doesn't change this bootstrap path.

### Transient tag `editor-handoff` (terminal-owning editors only)

The GUI editor path keeps the reducer unaware — it's a dialog-local `useEffect` (see §Editor handoff). The terminal-owning path can't: unmounting Ink is part of the sequence, so a component inside Ink can't orchestrate its own unmount coherently. Needs a reducer-level transient tag so the session coordinator owns the lifecycle, mirroring the `executing-step` post-transition hook in `src/session/session.ts` (`runConfirmedStep` kick-off on entering `executing-step`).

New tag `editor-handoff`:

- Shape: `{ tag: "editor-handoff"; origin: "composing-interactive" | "composing-followup" | "editing"; draft: string; response?: CommandResponse; round?: Round; outputSlot?: string }`. `response` / `round` / `outputSlot` carry through so returning to `composing-followup` or `editing` can restore the dialog state.
- New event `enter-editor { draft: string }` (dispatched by the Ctrl-G binding in all three origin dialogs). Reducer transitions `<origin>` → `editor-handoff` with the current draft + origin captured.
- New event `editor-done { text: string | null }` (dispatched by the coordinator after the spawn completes). `text: string` → buffer replaced; `text: null` → buffer kept (editor exited non-zero or wrote empty file per §Editor handoff exit handling). Reducer transitions `editor-handoff` → back to `<origin>` with `draft` updated (or preserved on null).
- `key-esc` → no-op during `editor-handoff` (the editor owns the TTY; Esc goes to the editor, not Wrap).
- NOT in `isDialogTag()` — the dialog is unmounted during terminal-owning handoff.

Coordinator post-transition hook on entering `editor-handoff` with a terminal-owning editor: run the 5-step sequence from §Editor handoff (unmount Ink → drop raw mode → pop kitty → spawn + await → remount on reducer transition back). On child exit, dispatch `editor-done` with the temp-file contents (or null per exit-code rules).

GUI editors bypass `editor-handoff` entirely — Ctrl-G in the dialog runs the local `useEffect` spawn, calls `dispatch({ type: "draft-change", text })` on completion, and never touches the transient tag. Reducer-unaware as spec'd.

---

## Dialog

Both new tags render through the existing response-dialog shell.

### `composing-interactive` view

- Top border: `compose` pill, left-aligned. Build using `PillSegment` (`src/tui/pill.tsx`) — same primitive used by the wizard breadcrumbs. No risk pill.
- Left border: low-risk blue gradient via `getRiskPreset("low").stops` (`src/tui/risk-presets.ts`).
- Body: TextInput (`multiline: true`) fills the dialog. No command fold, no explanation, no plan, no output slot.
- Bottom bar: new `INTERACTIVE_COMPOSE_ACTIONS` constant in `src/tui/response-dialog.tsx` — items `⏎ send`, `ctrl+G edit in <Editor>`, `Esc cancel`. Rendered via shared `ActionBar` (`src/tui/action-bar.tsx`) like all other bars. Hide the `ctrl+G` item when no editor resolved (see §Editor). ActionBar handles overflow compaction.

### `processing-interactive` view

Same dialog shell. TextInput switches to `readOnly` rendering the submitted `draft`. Bottom bar: reuse `PROCESSING_ACTIONS` (shared with `processing-followup` — `Esc to abort`); status spinner runs in the bottom border via `bottomStatus` derivation.

### Keys and sizing

Key routing uses the shared `useKeyBindings` hook (`src/tui/key-bindings.ts`) — NOT raw `useInput`. The compose dialog's bindings list is gated by `isActive: state.tag === "composing-interactive"`, matching the pattern already used for `editing` / `composing-followup` / `processing-followup` in `response-dialog.tsx`. Bindings:
- `escape` → `key-esc`
- `{ key: "g", ctrl: true }` → open editor (see §Editor handoff)
- `{ key: "j", ctrl: true }` → insert newline. Under kitty, Ctrl+J arrives as codepoint 106 + ctrl bit → `ctrl: true, input: "j"`, this binding fires.
- `input === "\n"` with `key.return === false` → insert newline. Without kitty, Ctrl+J is raw `\n` → Ink parses as `{ name: "enter", input: "\n", ctrl: false }`, distinct from plain Enter which sends `\r` → `key.return: true`. Universal fallback.

Width: standard dialog widening rule (see [[tui]]). Height: TextInput starts at 3 visible rows, grows with content up to `Math.max(3, terminalRows - DIALOG_CHROME_ROWS)`, then vertical scroll keeps cursor in view. `DIALOG_CHROME_ROWS = 6` (2 border + 2 padding + 1 pill/spacer + 1 hint).

Bar items pull the editor display name from the `EDITORS` record (see §Editor handoff) — unknown → basename.

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
- **Ctrl+J** (`0x0A`) — universal fallback. Under kitty, surfaces as `key.ctrl && input === "j"` (CSI-u encodes ctrl+letter). Without kitty, surfaces as `input === "\n"` with `key.return === false` — distinct from plain Enter which sends `\r` and surfaces as `key.return === true`. Both cases must be handled.
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

Message text is fixed (`Save and close editor to continue...`). Used by Ctrl-G handoff (see §Editor handoff). Three real consumers: `composing-interactive`, `composing-followup`, `editing` — all three call sites gain the Ctrl-G binding + `editingExternal` wiring in v1 (see §Editor handoff scope). Editor-handoff plumbing dwarfs the per-site wiring; symmetry is nearly free.

### Wrap and scroll (multiline only)

Soft-wrap long lines at dialog inner width. No horizontal scroll. Vertical scroll keeps the cursor on screen when logical+wrapped rows exceed available rows.

Cursor visual position on wrapped lines requires width-aware row/col computation — see §Cursor extensions.

### Buffer cap (multiline only)

Soft cap 256KB. Enforcement lives in one helper, `clampBufferSize(text): { value: string; truncated: boolean }`, called from every source that can grow the buffer: `Cursor.insert` (large paste), paste handler, editor-return handler. When `truncated === true`, show `paste truncated — for large input, pipe with cat file | w` in the bottom border. Banner clears on next keystroke. Truncation cuts at the last complete UTF-8 code point ≤ 256KB.

### Paste policy (multiline only)

Ink 7's `usePaste` hook owns bracketed paste: auto-enables `\x1b[?2004h` on mount, auto-disables on unmount, emits the full pasted string atomically, and keeps paste bytes out of `useInput`. Ink also handles the CSI pending-across-chunks case and wraps a paste-in-progress across multiple stdin chunks.

What's left for us in the `usePaste` handler:
- Sanitize: a single regex pass, e.g. `.replace(/\r\n|[\x00-\x08\x0B-\x1F\x7F]/g, m => m === "\r\n" ? "\n" : "")`. One pass, one allocation — don't chain `.replace()` calls.
- Run the sanitized string through `clampBufferSize` before inserting.
- Cursor lands at paste end.

No custom 5s timeout, Esc-during-paste accumulator reset, or accumulator byte cap — Ink's parser owns the paste-mode flag and buffers until `\x1b[201~` arrives or stdin closes.

---

## Keyboard protocol

**Ink 7 does the heavy lifting.** `parseKeypress` (`ink/build/parse-keypress.js`) parses kitty CSI-u natively — Shift+Enter arrives in `useInput` as `{ return: true, shift: true }`, Ctrl+J as `{ ctrl: true }` with `input === "j"`, printable chars as `text`, all with Ink's own pending-across-chunks buffering (`createInputParser`). `usePaste` owns bracketed paste (see §TextInput Paste policy). No custom stdin parser needed.

What we still own:

**Kitty enable/disable bytes.** Ink does not write `\x1b[>1u` / `\x1b[<u` itself — without them, most terminals send Shift+Enter as plain `\r` and the shift bit is lost. On compose mount write `\x1b[>1u`; on unmount write `\x1b[<u`. Bracketed paste enable/disable is handled by `usePaste` automatically — do not also send `\x1b[?2004h` ourselves.

**Mount order invariant:** drain stdin (1024-byte bounded loop per [[tui]]) BEFORE writing `\x1b[>1u`. Load-bearing — draining ahead of enable prevents an in-flight paste's `\x1b[200~` from being eaten by the drain, and prevents a buffered keystroke pressed before compose mounted from racing the first render.

Drop modifyOtherKeys. Ink's `parseKeypress` does not match the `CSI 27;m;code~` shape (`fnKeyRe` skips it), so enabling `\x1b[>4;2m` would produce no usable events. The Ctrl+J and `\`+Enter fallbacks cover terminals without kitty.

**Exit-guard teardown.** `ensureExitGuard()` in `src/core/spinner.ts` is currently file-private and registers a single teardown for the cursor-show sequence. Generalize to a subscriber registry — export `registerExitTeardown(bytes: string): () => void` (returns an unregister fn). The existing cursor-show teardown becomes the first registered subscriber, called from spinner.ts on its own module init so behavior is unchanged. Compose mount registers `\x1b[<u` and unregisters on unmount. Teardown runs on SIGINT / crash before Ink's restore so a killed Wrap never leaves the terminal in kitty mode.

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

**Scope:** Ctrl-G wires into three dialog states in v1 — `composing-interactive`, `composing-followup`, and `editing`. All three use the same `src/core/editor.ts` module, the same `editingExternal` TextInput prop, and the same terminal-owning / GUI dispatch. Per-site wiring is one `useKeyBindings` entry + one local `useEffect` that runs the editor spawn. Hint bars (`INTERACTIVE_COMPOSE_ACTIONS`, `FOLLOWUP_COMPOSE_ACTIONS`, `EDIT_COMMAND_ACTIONS`) each gain a `ctrl+G` item, hidden when `resolveEditor()` returns null.

New module `src/core/editor.ts`. Exports `resolveEditor(): Resolved | null` and a single `EDITORS` record:

```ts
type EditorMeta = { displayName: string; waitFlag?: string; gui?: boolean };
type Resolved = {
  path: string;           // absolute path from Bun.which / $VISUAL / $EDITOR
  key: string;            // basename without .exe suffix; used to look up EDITORS
  meta: EditorMeta;       // { displayName: basename, gui: false } for unknown editors
};
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

Resolution (first call wins, cached for the process lifetime via a module-level `let cachedEditor: Resolved | null | undefined`):
1. `$VISUAL` (trimmed)
2. `$EDITOR` (trimmed)
3. First available of `Object.keys(EDITORS)` via `Bun.which`, in declaration order — short-circuit on first hit; `Bun.which` is a sync stat, don't probe the full list.

The cache survives Ink remount (terminal-owning editors remount Ink, but the module is never reloaded), so the `Bun.which` sweep fires at most once per process invocation regardless of how many times Ctrl-G is pressed across how many dialog states.

Lookup key = `basename(resolved).replace(/\.exe$/i, "")` — strips directory and Windows `.exe` suffix before the `EDITORS` lookup. Handles `/usr/local/bin/code` → `code`, `C:\...\notepad.exe` → `notepad`.

`hasEditor = false` → hide `ctrl+G` segment from the bottom hint, don't register the handler. Unknown resolved editors (not in `EDITORS`) → render basename in the hint, no wait flag, treat as terminal-owning.

GUI editors without a known wait flag (e.g. `notepad++`, `gedit`) are omitted from `EDITORS` on purpose. Including them without a wait mechanism means Wrap reads an empty file because the editor forks instantly; better to fall back to the generic "unknown editor → terminal-owning" path, which at least surfaces the mismatch obviously.

Temp file via `ensureTempDir()` at `$WRAP_TEMP_DIR/prompt.md`. Write buffer → spawn (`Bun.spawn`, stdio `inherit`, `await proc.exited`) → on exit read file, trim trailing `\n`, delete temp file → update buffer.

Terminal-owning editors: the editor inherits stdio and needs the TTY in line mode, not raw mode. Orchestration lives in the session coordinator (`src/session/session.ts`), triggered by the reducer transition to `editor-handoff` (see §State → Transient tag `editor-handoff`). The dialog-local `useEffect` path used for GUI editors can't own this because Ink itself must unmount. Ordering inside the coordinator's post-transition hook:

1. Unmount Ink.
2. Call `process.stdin.setRawMode(false)` explicitly.
3. Write `\x1b[<u` to pop kitty disambiguate mode (see §Keyboard protocol). Bracketed paste is popped by `usePaste`'s own cleanup via Ink's unmount in step 1; do not also write `\x1b[?2004l`. modifyOtherKeys is not in use.
4. `Bun.spawn` the editor with stdio `inherit`; `await proc.exited`.
5. Read temp file per the exit-code rules below; dispatch `editor-done { text }`. Reducer transitions `editor-handoff` → origin tag with updated draft. Coordinator remounts Ink on that transition (Ink re-enters raw mode and re-applies the protocol modes as part of compose mount).

Step 2 is load-bearing. Ink's unmount does not always clear raw mode — the flag remains latched on `process.stdin`, and the child editor inherits a raw-mode TTY. Symptom: `vim` / `nano` receive no character-at-a-time input (or wedged escape sequences), display is broken until the user force-exits. Explicitly dropping raw mode after unmount guarantees the editor sees a normal line-discipline TTY. The re-enable on step 5 is handled by Ink itself on mount — do not call `setRawMode(true)` manually or it races Ink.

GUI editors (`gui: true`): keep Ink mounted, bypass `editor-handoff` entirely. Ctrl-G checks `resolveEditor().meta.gui` before dispatching: if true, skip the reducer and run the dialog-local `useEffect` path below; if false (terminal-owning or unknown), dispatch `enter-editor` and let the coordinator take over. The dialog renders `editingExternal={true}` during the GUI spawn so the user sees the "Save and close..." frame:

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

Submit dispatches `submit-interactive` → reducer transitions to `processing-interactive` → coordinator hook pushes the initial user turn from `draft` and starts the pump loop. The dialog stays mounted: TextInput renders read-only with the submitted draft; bottom-border spinner runs.

Verbose lines from startup buffer while the dialog is mounted, flush to scrollback on teardown (existing behavior).

When `--verbose` is on, echo the submitted prompt as a dim multi-line stderr block on teardown (using existing buffering of output mechanism).

---

## Exit codes

User-initiated cancel returns 0 from anywhere in the session. Pressing Esc or Ctrl-C in any compose / confirming / editing dialog state is a graceful abort, not an error.

Change in `src/session/session.ts` `finaliseOutcome`: `cancel` returns 0 (was 1). `exhausted`, `blocked`, `error` keep returning 1 — those are limit / environment / system failures, not user choices.

Esc:
- `composing-interactive` → `exiting { kind: "cancel" }`.
- `composing-followup` → unchanged (back to `confirming`).
- `processing-interactive` → `composing-interactive`, draft preserved, in-flight LLM aborted.
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
- **State tag names use `-followup` / `-interactive` suffixes symmetrically.** Existing `composing` / `processing` rename to `composing-followup` / `processing-followup` in a pre-step; new tags are `composing-interactive` / `processing-interactive`. Each tag is a self-contained shape per [[session]] convention.
- **Event name: `submit-interactive` (parallels `submit-followup`).** The coordinator distinguishes bootstrap (empty transcript) from append (existing transcript) at submit time, not via tag inspection.
- **Cancel exits 0.** User-initiated abort is graceful, not a failure. Existing `cancel` outcome is rewired.
- **`editingExternal` is a TextInput prop, not session state.** Three real consumers in v1 — `composing-interactive`, `composing-followup`, `editing` — all gain Ctrl-G wiring.
- **Ctrl+J + `\`+Enter as guaranteed fallbacks.** Work in every terminal without protocol detection; Ctrl+J surfaces differently under kitty vs. not (see §Dialog Keys).
- **256KB buffer cap.** Above this, Ink reflow freezes per keystroke. Our own width math (visualRow/Col) is a rounding error relative to Ink reflow at that size — no premature memoization.
- **Static placeholder, no rotation.** Motion while typing distracts.
- **Skip Ink unmount for GUI editors.** They don't take the TTY — unmounting is pure flicker.
- **Lean on Ink 7's `parseKeypress` + `usePaste`; no custom stdin parser.** Ink 7 parses kitty CSI-u natively (Shift+Enter, Ctrl+letter, printable text field), and `usePaste` owns bracketed paste with atomic strings. A parallel stdin listener or detach-and-forward scheme would duplicate Ink's work and break byte ordering. We write only the kitty enable/disable bytes — the rest comes free.
- **Drop modifyOtherKeys (`\x1b[>4;2m`).** Ink's `parseKeypress` doesn't match `CSI 27;m;code~`, so enabling it yields no usable events. Kitty + Ctrl+J + `\`+Enter is sufficient coverage.
- **Bottom bar uses shared `ActionBar` + `useKeyBindings`.** `src/tui/response-dialog.tsx` consolidated onto these primitives in commit 25e5da0. Compose follows the same pattern; no fresh `useInput` hooks.
- **Hint-constant rename to `_ACTIONS` suffix.** Pre-step — see §Pre-step renames. Was `_HINT_ITEMS` (legacy name from before the ActionBar consolidation).
- **Drop Ctrl+X Ctrl+E chord from v1.** Would be the first keyboard chord in the codebase; adds stateful timer tracking for a muscle-memory alias of Ctrl+G. Ctrl+G already works and is in the bar. Add later if users ask, ideally via a generic chord helper on `useKeyBindings`.

---

## Pre-step renames

Landed before the interactive-mode work begins, as a standalone PR. No behavior change. Keeps the interactive-mode diff focused on the feature rather than a cross-cutting rename.

**State tags** (`src/session/state.ts`, `src/session/reducer.ts`, `src/session/session.ts`, `src/tui/response-dialog.tsx`, plus any tests referencing the tag strings):
```
composing   →  composing-followup
processing  →  processing-followup
```

Events in `src/session/state.ts` stay as-is (`submit-edit`, `submit-followup`, `draft-change` — already unambiguous).

**Hint constants** (`src/tui/response-dialog.tsx`). Rename from `_HINT_ITEMS` (leftover from the pre-ActionBar `KeyHints` component) to `_ACTIONS` for consistency with the rendering primitive:
```
ACTION_ITEMS               →  CONFIRMING_ACTIONS
ACTION_BAR_ITEMS           →  CONFIRMING_BAR_ITEMS
ACTION_BAR_WIDTH           →  CONFIRMING_BAR_WIDTH
EDIT_HINT_ITEMS            →  EDIT_COMMAND_ACTIONS
COMPOSE_HINT_ITEMS         →  FOLLOWUP_COMPOSE_ACTIONS
PROCESS_HINT_ITEMS         →  PROCESSING_ACTIONS
EXECUTING_STEP_HINT_ITEMS  →  EXECUTING_STEP_ACTIONS
```

Rationale: `EDIT_COMMAND` disambiguates from general text editing; `FOLLOWUP_COMPOSE` leaves room for the peer `INTERACTIVE_COMPOSE_ACTIONS` added later; `PROCESSING_ACTIONS` stays context-agnostic because both follow-up and interactive wait on the LLM identically (just `Esc to abort`); `EXECUTING_STEP` is a phase, not a mode-specific bar.

---

## Implementation slices

Pre-step renames already landed in commit a15630c — do not re-apply.

1. **Cancel → exit 0.** Change `finaliseOutcome` in `src/session/session.ts`: `cancel` returns 0 (was 1). Update any tests asserting exit 1 on cancel. `exhausted` / `blocked` / `error` keep returning 1.
2. **Cursor line helpers:** add `upLine`, `downLine`, `row`, `col` to `Cursor`. Unit-test against multiline strings.
3. **TextInput `multiline` prop + `editingExternal`:** discriminated-union prop; Enter behavior branched via `useKeyBindings` entries (`{ key: "j", ctrl: true }`, shift+return, backslash-return, `input === "\n"` fallback for non-kitty Ctrl+J); `\n` rejected on insert when single-line. Soft-wrap render + cursor visual. Paste via Ink's `usePaste` — sanitize + `clampBufferSize` on the emitted string. New TextInput tests for: Shift+Enter inserts `\n`, Ctrl+J inserts `\n` (both kitty and non-kitty paths), backslash-Enter conversion, paste `\n` preserved/stripped, plain Enter submits in both modes, `editingExternal` disables input + renders label. Existing tests stay green.
4. **State tags + events + reducer transitions.** Pure reducer work — no rendering, no coordinator side effects, no trigger. Add `composing-interactive` + `processing-interactive` + `editor-handoff` to the `AppState` union in `src/session/state.ts`. Add `submit-interactive` + `enter-editor` + `editor-done` to `AppEvent`. Update `isDialogTag` — include the two new composing/processing tags, EXCLUDE `editor-handoff` (dialog is unmounted during terminal-owning handoff). Add reducer cases in `src/session/reducer.ts` per §State (draft updates, Esc routing, loop-final routing for `processing-interactive`, `editor-handoff` round-trip). Reducer-level unit tests for each transition, including `editor-handoff` round-trip from each origin.
5. **Coordinator hook + ResponseDialog render branch.** In `src/session/session.ts`, add a post-transition hook for `processing-interactive` mirroring the existing `processing-followup` branch in `dispatch` (push `{ kind: "user", text: state.draft }` transcript turn, reset `loopState.budgetRemaining = maxRounds`, call `startPumpLoop`). Add a post-transition hook for `editor-handoff` that orchestrates the 5-step terminal-owning sequence (see §Editor handoff) — but in this slice, stub the spawn step since editor resolution lands in slice 8. Add `INTERACTIVE_COMPOSE_ACTIONS` constant to `src/tui/response-dialog.tsx`. Add a new state-keyed render block for `composing-interactive` / `processing-interactive` alongside the existing `composing-followup` / `processing-followup` branch. End-to-end: dialog can render but is not yet reachable from CLI.
6. **Trigger + mock-TTY harness.** In `src/main.ts`, reorder the main flow so `input.type === "none" && process.stdin.isTTY` calls `runSession(prompt: "")`. In `runSession`, when the initial prompt is empty and stdin is a TTY, seed initial state as `composing-interactive` (not `thinking`). Build a mock-TTY seam parallel to `src/core/piped-input.ts` (a `StdinSource`-like interface) so `main.ts`' trigger branch is integration-testable. First integration test: no-args TTY → compose mounts → user types → submit → transcript seeded → exit.
7. **Kitty enable/disable + exit-guard generalization.** Generalize `ensureExitGuard` in `src/core/spinner.ts` to a `registerExitTeardown(bytes)` subscriber registry; the existing cursor-show teardown becomes the first subscriber (registered from spinner.ts at module init). On compose mount, drain stdin (load-bearing ORDER — drain first) then write `\x1b[>1u` and register `\x1b[<u` with the exit-guard; on unmount unregister and write the pop. No custom parser — Ink 7's `parseKeypress` + `usePaste` cover everything. No modifyOtherKeys.
8. **Placeholder.** Hardcoded set per §Placeholder; static random pick on mount; hide on keystroke or paste-start.
9. **Editor handoff.** New module `src/core/editor.ts` (`resolveEditor(): Resolved | null` with module-level cache, `EDITORS` record per §Editor handoff). Wire Ctrl-G bindings via `useKeyBindings` into all three origin dialogs (`composing-interactive`, `composing-followup`, `editing`). Ctrl-G branches on `resolveEditor().meta.gui`: GUI → dialog-local `useEffect` spawns editor, sets local `editorOpen`, TextInput renders `editingExternal={true}`, on exit dispatches `draft-change`; terminal-owning → dispatch `enter-editor { draft }` and let the coordinator hook from slice 5 run the real spawn (un-stub). Temp file via `ensureTempDir` (`src/fs/temp.ts`) at `$WRAP_TEMP_DIR/prompt.md`. Add `ctrl+G` item to each of `INTERACTIVE_COMPOSE_ACTIONS`, `FOLLOWUP_COMPOSE_ACTIONS`, `EDIT_COMMAND_ACTIONS` (hidden when `resolveEditor()` returns null).
10. **Follow-up TextInput swap.** Flip `multiline: true` on the existing follow-up TextInput call site in `src/tui/response-dialog.tsx`. State tag unchanged.
11. **Discoverability + logging.** Examples block in `--help` (`src/subcommands/help.ts`, `renderPlain` + `renderStyled`); add `input_source: "argv" | "pipe" | "tui"` to `LogEntry`; `--verbose` prompt-trace echo on teardown.

**Slice dependencies:** 1 standalone. 2 before 3. 3 before 5 (render needs multiline TextInput) and before 10 (follow-up swap needs multiline). 4 before 5 (coordinator hook references the new tags) and before 9 (Ctrl-G dispatches the new events). 5 before 6 (trigger hits the new tag → needs coordinator hook + render). 7 before any real end-to-end kitty testing. 9 unstubs the coordinator's editor spawn from slice 5. 8, 10, 11 are independent after 5.

TDD per project rule. Unit-test `clampBufferSize` (UTF-8 boundary, below-cap passthrough, above-cap truncation). Unit-test the backslash-Enter + Ctrl+J (both paths) + Shift+Enter paths through TextInput's `useKeyBindings` bindings using `ink-testing-library`. Reducer-test `editor-handoff` round-trip from each origin (draft update + draft preserve on null). Integration-test the `main.ts` trigger branch with the mock TTY harness built in slice 6.
