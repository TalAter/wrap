# Dialog Implementation

Architecture reference for the dialog (the interactive Ink TUI that handles command confirmation, edit, follow-up, and processing). Visual design and risk palettes live in `tui-approach.md`; `dialog-style.sh` is the ANSI reference mockup. Canonical TUI vocabulary (dialog, action bar, risk badge, dialog state) lives in `SPEC.md` §Glossary.

Code: `src/tui/dialog.tsx`, `src/tui/border.ts`, `src/session/dialog-host.ts`, `src/session/notification-router.ts`.

## 3-column layout

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

## Borders (`src/tui/border.ts`)

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

## Input

`useInput` is used, gated by `{ isActive: state.tag === "<tag>" }` so each handler only fires for its own state. Four handlers: editing (Esc only), confirming (arrows, Enter, Esc, hotkeys, `q`), composing (Esc), processing (Esc). Printable keys in editing/composing go through `<TextInput>`, which owns the draft buffer.

**Why custom `text-input.tsx` instead of `ink-text-input`:** `ink-text-input` can't be styled with `backgroundColor` (it renders its own internal `<Text>`, so the dark `#232332` strip wouldn't span wrapped lines) and lacks word-jump, Home/End, and kill-to-start. Our implementation wraps a `Cursor` abstraction (`src/tui/cursor.ts`) with full control over styling and keyboard. Edit-mode keybindings: Ctrl+A/E (home/end), Ctrl+U/K (kill-to-start / kill-to-end), Ctrl+Y (yank killed text), Alt+B/F or Alt+←/→ (word jump), Alt+Backspace (delete word left), Enter to submit (empty blocked).

**Stdin drain on every tag transition.** The dialog reads up to 1024 bytes from stdin on mount and on every `state.tag` change. This kills buffered keystrokes that the user pressed while waiting for the LLM — without it, a stray Enter pressed during `thinking` lands on the first confirming frame and dispatches `run` against a dangerous command the user never confirmed. The reducer-based state machine prevents events from reaching the wrong tag, but it cannot prevent keystrokes the terminal buffered before the dialog mounted. The 1024 cap is insurance against a misbehaving stream that never returns null.

### Action bar

`ACTION_ITEMS` is a const table of `{ id, label, primary, hotkey }`. `id` is the stable `ActionId` used in `key-action` dispatches; `label` is presentation-only. **Convention:** each hotkey is `label[0].toLowerCase()`, so the bar can underline the first letter as the shortcut hint without a separate field. `q` is a hardcoded alias for `cancel` because it doesn't match any label's first letter.

Keybindings (identical for every risk level — simplified from the earlier tiered scheme in SPEC.md):

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

**Stderr, not stdout.** Ink is rendered to `process.stderr` because stdout is reserved for useful output (hard rule — see CLAUDE.md / SPEC.md). `patchConsole: false` because Wrap has its own stderr sink (the notification router, below).

**Cursor restore on unmount** guards against bun#26642 (cursor stays hidden on macOS after Ink exits). Cheap insurance even once that bug lands.

## Notification router (`src/session/notification-router.ts`)

The router is the **single source of truth for "is the dialog up?"** The coordinator does not track its own `dialogMounted` flag; it asks the router via `isDialogMounted()` / `getDialog()`. This keeps mount lifecycle and notification routing from drifting apart.

Routing rules for each notification emitted on the global bus:

1. **No dialog** → write straight to stderr (chrome lines from initial probes / memory updates land in scrollback as they happen).
2. **Dialog mounted** → buffer for replay on unmount. Stderr writes during alt-screen would otherwise land in the alt buffer and vanish on exit.
3. **Dialog mounted AND session is in `processing`** → additionally call `onProcessingChrome(n)` so the coordinator can dispatch a `notification` event and the reducer can surface the latest chrome line in the bottom border.

`teardownDialog()` unmounts (writing `EXIT_ALT_SCREEN` first) and then flushes the buffer to real stderr, so replayed lines land in scrollback rather than the alt buffer that's about to disappear. Idempotent.

`isProcessing` is pulled (callback) rather than pushed — the router doesn't mirror the coordinator's state, it just asks.

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
