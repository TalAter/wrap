# TUI

How Wrap renders interactive UI, and how the confirmation dialog is built. Canonical TUI vocabulary (dialog, action bar, risk badge, dialog state) lives in `SPEC.md` §Glossary. `dialog-style.sh` is the ANSI reference mockup.

Code: `src/tui/dialog.tsx`, `src/tui/border.ts`, `src/tui/text-input.tsx`, `src/tui/spinner.ts`, `src/session/dialog-host.ts`, `src/session/notification-router.ts`.

## Framework: Ink 5+, lazy-loaded

Ink (React for CLIs) handles every interactive surface: the confirmation dialog, the config wizard, interactive mode. Non-interactive output stays on the `chrome()` / `chromeRaw()` utilities in `src/core/output.ts`.

**Why Ink**
- Flexbox/Yoga layout, built-in wrapping, `useInput`/`useStdin`, `measureElement`. Everything we'd otherwise hand-roll.
- Production-proven in Bun: Anthropic's own Claude Code CLI ships as a Bun-compiled Ink binary.
- Ink 5+ required. Earlier versions have WASM/compile issues with `bun build --compile`. Yoga 3.2.x (Ink's layout engine) ships as embedded base64 WASM — no native bindings, works with `bun build --compile` (bun#6567, fixed June 2025).

**Why lazy-loaded.** Ink + React + Yoga adds ~1MB to the compiled binary and ~50–100ms of init. The common path — a low-risk command — never needs interactive UI, so Ink must not be paid for on every invocation. Load is kicked off by `preloadDialogModules()` in `src/session/dialog-host.ts`, which runs in parallel with the first LLM call. By the time a dialog is needed the modules are cached and `mountDialog()` is synchronous.

## Three output tiers

All Wrap chrome goes to **stderr** or **/dev/tty**. Never stdout. This is a hard rule (see `SPEC.md`).

1. **Static chrome** — `chrome()` / `chromeRaw()`. Plain text to stderr. Errors, status lines, post-exec summaries.
2. **Animated chrome** — spinners, streaming tokens. `chromeRaw()` + `setInterval` + cursor control. No Ink. See `src/core/spinner.ts`.
3. **Interactive UI** — Ink. Dialog, config wizard, interactive mode, error recovery.

Tier 2 exists specifically so the "thinking..." indicator doesn't force an Ink load. Once we're paying for Ink anyway (e.g. dialog up), in-dialog animation uses a React hook (`useSpinner` in `src/tui/spinner.ts`) driven off the same frame table.

## Ink configuration constraints

### Render to stderr

`render(<Component />, { stdout: process.stderr, patchConsole: false })`. Redirects all Ink layout and re-render output to stderr. Stdout stays clean for command output. `patchConsole: false` because Wrap's own stderr sink (the notification router, below) is the coordination point — we don't want Ink to also intercept `console.log`.

### Input when stdin is piped

Wrap supports `cat file | w explain this`, so `process.stdin` is often consumed by the pipe. The Unix-standard fix is to open `/dev/tty` directly (same pattern fzf/sudo/less use). Bun supports this.

<!-- FLAG: code currently passes only `stdout` to `render()`. `/dev/tty` fallback for piped-stdin interactive mode is spec'd but the dialog-host wiring doesn't show an explicit `stdin:` option yet. Verify during piped-input interactive-mode work. -->

### Input buffer flush on mount

Before the dialog becomes interactive, drain any buffered stdin. A stray Enter that the user hit while waiting for the LLM must not auto-confirm a dangerous command. The dialog component drains `stdin.read()` on first mount and on every state-tag transition (see `src/tui/dialog.tsx`). The drain is bounded (1024 reads) so a misbehaving stream can't hang the render.

This is a safety invariant, not a nice-to-have.

### Cursor restore

Bun has a known bug (bun#26642) where the cursor disappears after an Ink app exits on macOS. `dialog-host.ts` writes `SHOW_CURSOR` on unmount. `src/core/spinner.ts` also installs a one-time process-exit guard that unconditionally writes `SHOW_CURSOR`, covering Ctrl-C and uncaught throws. Cheap insurance even after the Bun bug is fixed.

### Clean teardown before exec

Before Wrap spawns the confirmed child command, Ink must be fully unmounted: alt-screen exited, cursor restored, raw mode released. The terminal must be in normal state before the child inherits the tty.

`dialog-host.ts` wraps mount with `ENTER_ALT_SCREEN` and unmount with `EXIT_ALT_SCREEN` + `SHOW_CURSOR`. The notification router (`src/session/notification-router.ts`) is the single caller of `teardownDialog()` and guarantees it runs before exec.

**Why the alt screen at all:** rendering in the alternate screen buffer means resize artifacts and Ink re-renders can't corrupt the user's main scrollback. On unmount we drop back to the main buffer with history intact.

### `useInput` on Bun

Ink 5 had trouble with `useInput` on Bun (bun#6862) because Bun's `process.stdin` didn't match Ink's expectations. Ink 6.8 rewrote `useInput` on top of `useStdin`, which works. The dialog uses `useInput` directly. If a future Bun/Ink regression breaks this, fall back to raw `useStdin` + `setRawMode(true)`.

## Notification router — stderr routing while Ink is mounted

Ink owns the stderr screen region while it's rendering. Uncoordinated `chrome()` / `chromeRaw()` writes during that window corrupt the display and, worse, land in the alt-screen buffer that vanishes on exit — so the user never sees them at all.

**Solution:** a notification router (`src/session/notification-router.ts`) subscribes to the global notification bus and dispatches each notification. The router is the **single source of truth for "is the dialog up?"** The coordinator does not track its own `dialogMounted` flag; it asks the router via `isDialogMounted()` / `getDialog()`. This keeps mount lifecycle and notification routing from drifting apart.

Routing rules for each notification emitted on the global bus:

1. **No dialog** → write straight to stderr (chrome lines from initial probes / memory updates land in scrollback as they happen).
2. **Dialog mounted, not in `processing`** → buffer for replay on unmount. Stderr writes during alt-screen would otherwise land in the alt buffer and vanish on exit.
3. **Dialog mounted AND session is in `processing`** → buffer **and** additionally call `onProcessingChrome(n)` so the coordinator can dispatch a `notification` event and the reducer can surface the latest chrome line in the bottom border.

`teardownDialog()` unmounts (writing `EXIT_ALT_SCREEN` first) and then flushes the buffer to real stderr, so replayed lines land in scrollback rather than the alt buffer that's about to disappear. Idempotent.

`isProcessing` is pulled (callback) rather than pushed — the router doesn't mirror the coordinator's state, it just asks.

See `specs/follow-up.md` §"Stderr message routing" for the in-processing case.

## Dialog: 3-column layout

The dialog is a vertical stack: top border, 3-column row (left gradient border / middle content / right dim border), bottom border.

**Why custom borders instead of Ink's `borderStyle="round"`:** Ink's native border supports only one color per side — no vertical gradient, no in-border risk badge. Ink's `<Transform>` can't wrap `<Box>` children (Transform is a text node, throws at runtime). The 3-column split lets the middle column use standard Ink flexbox for wrapping and state while left/right/top/bottom are rendered as plain `<Text>` runs with per-glyph colors.

The middle column uses standard Ink components only. Ink handles word-boundary wrapping for command, explanation, and action bar. No manual text wrapping anywhere.

Left border is an array of `<Text>` lines, each with a gradient color from `interpolateGradient(row, borderCount, riskLevel)`. Right border is the same shape but all dim `#3c3c64`.

### Width

```
innerWidth  = totalWidth - 4           (2 border columns * 2 cells)
totalWidth  = min(natural + 4, termCols - 4)
natural     = max(stringWidth(command), stringWidth(explanation), stringWidth(draft?), MIN_INNER_WIDTH)
```

`MIN_INNER_WIDTH = ACTION_BAR_WIDTH + 4`, so on ordinary terminals the action bar never wraps. On narrow terminals Ink wraps it naturally and the height-sync loop (below) grows the borders to match.

### Height sync

The border columns need exactly as many `│` rows as the middle column's rendered height. We compute a first-pass estimate from content (line counts for command / explanation / follow-up draft / action bar / padding) so the initial render is usually correct in one pass. A `useLayoutEffect` then calls `measureElement(middleRef)` and, if the real height differs, updates `borderCount` — one extra render, Ink swaps the frame.

**Why not `measureElement` alone (no estimate):** earlier drafts ran into feedback loops where the measured height re-triggered layout. Seeding state with a content-derived estimate keeps the first frame stable and makes the effect a pure correction step.

### Borders (`src/tui/border.ts`)

`topBorderSegments()` and `bottomBorderSegments()` return arrays of styled text segments (`{ text, color?, backgroundColor?, bold? }`) rendered by a small `<BorderLine>` wrapper. Segments — not ANSI strings — so Ink owns all styling.

**Top border** embeds the risk badge pill near the right end: `╭─────── ⚠ medium risk ──╮`. Each `─` / corner gets its color from `interpolateGradient(charIndex, totalWidth, riskLevel)` (horizontal gradient, same stops as the vertical left border). The badge is a single segment with tinted bg + risk-colored bold fg, per-level definitions co-located in the `RISK` table in `border.ts`. Colocation is deliberate: tuning a risk level's look touches one place.

**Bottom border** is all dim (`[60,60,100]`). When a `bottomStatus` is provided (spinner + chrome text during `processing`), it renders as `╰─ <status> ─...─╯` with the status in near-white `#d2d2e1`. If the status is wider than `totalWidth - 6` it's truncated with an ellipsis; if even that can't fit, the status is dropped and the border collapses to plain dashes. Spaces around the status are part of the dim segments so the white run doesn't extend past the visible label.

### Gradient interpolation

`interpolateGradient(index, total, risk)` maps `index / (total - 1)` to a position in the risk-specific stops and returns a hex color. Used by both the left border (index = row, total = borderCount) and the top border (index = char, total = totalWidth). The stops are reused by ANSI helpers elsewhere, so `interpolate()` and the `Color` type are exported from `src/core/ansi.ts`.

## Dialog states and state-driven rendering

The dialog is mounted iff `AppState.tag` is a dialog tag: `confirming`, `editing`, `composing`, or `processing` (see `src/session/state.ts`, `isDialogTag`). The reducer is the single source of truth for which tag we're in; the dialog is pure presentation and dispatches `AppEvent`s.

The middle column's content below the command row switches on `state.tag`:

| Tag | Middle content | Bottom-row slot |
|---|---|---|
| `confirming` | command (read-only), explanation | `<ActionBar>` |
| `editing` | editable `<TextInput>` bound to `state.draft` | edit key hints (`⏎ to run`, `Esc to discard`) |
| `composing` | command, explanation, follow-up `<TextInput>` (placeholder `actually...`) | compose key hints |
| `processing` | command, explanation, follow-up text (read-only) | process key hints (`Esc to abort`), spinner + status in bottom border |

`selectedIndex` for the action bar is local presentation state. It resets to 0 on every transition out of `confirming` so re-entering never shows a stale highlight.

## Input handling

`useInput` is used, gated by `{ isActive: state.tag === "<tag>" }` so each handler only fires for its own state. Four handlers: editing (Esc only), confirming (arrows, Enter, Esc, hotkeys, `q`), composing (Esc), processing (Esc). Printable keys in editing/composing go through `<TextInput>`, which owns the draft buffer.

**Why custom `text-input.tsx` instead of `ink-text-input`:** `ink-text-input` can't be styled with `backgroundColor` (it renders its own internal `<Text>`, so the dark `#232332` strip wouldn't span wrapped lines) and lacks word-jump, Home/End, and kill-to-start. Our implementation wraps a `Cursor` abstraction (`src/tui/cursor.ts`) with full control over styling and keyboard. Edit-mode keybindings: Ctrl+A/E (home/end), Ctrl+U/K (kill-to-start / kill-to-end), Ctrl+Y (yank killed text), Alt+B/F or Alt+←/→ (word jump), Alt+Backspace (delete word left), Enter to submit (empty blocked).

**Stdin drain on every tag transition.** The dialog reads up to 1024 bytes from stdin on mount and on every `state.tag` change. This kills buffered keystrokes that the user pressed while waiting for the LLM — without it, a stray Enter pressed during `thinking` lands on the first confirming frame and dispatches `run` against a dangerous command the user never confirmed. The reducer-based state machine prevents events from reaching the wrong tag, but it cannot prevent keystrokes the terminal buffered before the dialog mounted. The 1024 cap is insurance against a misbehaving stream that never returns null.

### Action bar

`ACTION_ITEMS` is a const table of `{ id, label, primary, hotkey }`. `id` is the stable `ActionId` used in `key-action` dispatches; `label` is presentation-only. **Convention:** each hotkey is `label[0].toLowerCase()`, so the bar can underline the first letter as the shortcut hint without a separate field. `q` is a hardcoded alias for `cancel` because it doesn't match any label's first letter.

Keybindings (identical for every risk level — simplified from the earlier tiered scheme in SPEC.md where high-risk required `y+Enter`; the dialog's explicit selection + confirmation model already provides the safety that the extra keystroke was buying):

| Key | Action |
|---|---|
| `y` | run |
| `n`, `q`, `Esc` | cancel |
| `d` | describe (no-op in phase 1) |
| `e` | edit |
| `f` | follow-up |
| `c` | copy (no-op in phase 1) |
| `←` `→` | move `selectedIndex` |
| `Enter` | activate the selected item |

## Host lifecycle (`src/session/dialog-host.ts`)

Ink + React + `Dialog` are lazy-loaded via `preloadDialogModules()`, kicked off in parallel with the first LLM call so `mountDialog()` is synchronous by the time the session needs it. `mountDialog` writes `ENTER_ALT_SCREEN`, calls `ink.render(..., { stdout: process.stderr, patchConsole: false })`, and returns a `{ rerender, unmount }` handle. `unmount` writes `EXIT_ALT_SCREEN + SHOW_CURSOR`.

**Stderr, not stdout.** Ink is rendered to `process.stderr` because stdout is reserved for useful output (hard rule — see CLAUDE.md / SPEC.md). `patchConsole: false` because Wrap has its own stderr sink (the notification router, above).

**Cursor restore on unmount** guards against bun#26642 (cursor stays hidden on macOS after Ink exits). Cheap insurance even once that bug lands.

## Dialog visual design

**Aesthetic.** Synthwave gradient border that shifts hue by risk level. Rounded corners (`╭╮╰╯`), thin lines. No heavy-rounded variant exists in Unicode. Left border and top border carry the gradient; right and bottom fade to a dim neutral `[60,60,100]`. Command sits on a tinted background strip (code-block feel). Risk badge pill embedded in the top-right border (`─── ⚠ medium ──╮`).

**Risk palettes** (also used by `border.ts`):
- **Low** — teal → blue → dim. Green `✔ low risk` badge. (Low-risk commands usually skip the dialog entirely, but the palette exists for the `--always-confirm` path.)
- **Medium** — pink → purple → dim. Amber badge on warm bg.
- **High** — red → magenta → purple → dim. Red badge on dark red bg.

**Action bar** — `Run command?  Yes  No  │  Describe  Edit  Follow-up  Copy`. Y/N primary (warm accent), secondary actions (D/E/F/C, cool accent) separated by a dim `│`. Shortcut letter is bold + underlined; rest of word dim. Arrow keys navigate, Enter activates the highlighted item, hotkeys fire directly.

## Where Ink is used

- **Dialog** — medium/high-risk command confirmation. Layout, borders, action bar, follow-up compose, edit, processing spinner.
- **Config wizard** — first-run and `w config`. Provider select, masked API-key entry, model select.
- **Interactive mode** — `w` with no args. Multiline editor. See `specs/interactive-mode.md`.
- **Error recovery** — "Retry? Edit? Explain?" after a failed command. Simpler variant of the dialog.

## Where Ink is NOT used

- **Answer rendering** — markdown-formatted text to stdout (TTY) or plain (piped). No interactivity.
- **Streaming LLM responses** — Tier 2, stderr.
- **Spinners / progress** — Tier 2 (Ink's `useSpinner` hook is only used once the dialog is already mounted).
- **Status, errors, post-exec summaries** — Tier 1 `chrome()`.

## Companion libraries (suggestions, not mandates)

- `string-width` — width of wrapped content (used explicitly; also a transitive Ink dep).
- `cli-highlight` / `highlight.js` — shell syntax highlighting for the command (deferred to phase 2).
- `marked-terminal` — answer-mode markdown rendering.
- `picocolors` — only if `src/core/ansi.ts` needs extending. It currently covers bold, dim, 24-bit RGB, gradients.
- `nanospinner` — or the hand-rolled `~20 LOC` in `src/core/spinner.ts` (we chose the latter).

## File map

- `src/tui/dialog.tsx` — `Dialog`, `ActionBar`, `KeyHints`, `BorderLine`, `useRenderSize`, action item table
- `src/tui/border.ts` — gradient interpolation, risk palettes + badges, top/bottom border segment builders
- `src/tui/text-input.tsx` — editable text field used by editing / composing
- `src/tui/spinner.ts` — spinner frame hook for the bottom-border status
- `src/session/dialog-host.ts` — lazy module load + mount/rerender/unmount
- `src/session/notification-router.ts` — stderr sink, buffer, "is dialog up?" authority
- `src/session/state.ts` — `AppState`, `AppEvent`, `ActionId`, `isDialogTag`
- `src/session/reducer.ts` — pure state machine driving the dialog
- `src/core/ansi.ts` — exports `interpolate()` and `Color`

## Deferred

- Syntax highlighting for the command row (shell tokenizer).
- `describe` and `copy` handler implementations. (`edit` done; `followup` done — see `specs/follow-up.md`.)
- Responsive action bar: shrink labels or abbreviate on narrow terminals instead of wrapping.
