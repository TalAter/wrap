---
name: tui
description: Ink dialog, three output tiers, custom borders, text input, action bar, host lifecycle
Source: src/tui/, src/session/dialog-host.ts, src/session/notification-router.ts, src/core/clipboard.ts
Last-synced: 9fe9903
---

# TUI

## Framework

Ink 7 (React for CLIs). Handles every interactive surface: confirmation dialog, config wizard, interactive mode.

Lazy-loaded. Ink + React + Yoga adds ~1MB and ~50–100ms init. Common path (low-risk command) never needs it. `preloadResponseDialogModules()` runs in parallel with the first LLM call; by the time a dialog is needed modules are cached. Config wizard has its own separate lazy import — never loaded on normal invocations.

## Three output tiers

1. **Static chrome** — `chrome()` / `chromeRaw()`. Plain text to stderr.
2. **Animated chrome** — spinners. `chromeRaw()` + `setInterval` + cursor control. No Ink.
3. **Interactive UI** — Ink. Dialog, wizard, interactive mode.

Tier 2 exists so the "thinking…" spinner doesn't force an Ink load. Once the dialog is up, in-dialog animation uses Ink's `useAnimation` with `SPINNER_FRAMES` / `SPINNER_INTERVAL` from `src/core/spinner.ts`.

## Ink configuration

- **Render to stderr.** `render(<C />, { stdout: process.stderr, patchConsole: false, alternateScreen: true })`. Stdout stays clean.
- **Alt-screen.** Resize artifacts can't corrupt scrollback. Unmount drops back to main buffer with history intact.
- **Cursor restore on unmount.** Guards against Bun bug (bun#26642) where cursor stays hidden after Ink exit.
- **Stdin drain.** Dialog reads up to 1024 bytes from stdin on mount and every state-tag transition. Kills buffered keystrokes — a stray Enter during `thinking` must not auto-confirm a dangerous command. Safety invariant.

## Dialog layout

Vertical stack: top border, 3-column row (left gradient / middle content / right dim border), bottom border.

Why custom borders: Ink's native border supports one color per side — no vertical gradient, no in-border pills.

Middle column uses standard Ink flexbox for wrapping. Left border is per-row gradient colors. Right border is dim `[60,60,100]`.

Width: `min(max(natural, pillFullWidth - 2) + 4, termCols - 4)`. Dialog widens to fit the full top pill when the terminal allows. `MIN_INNER_WIDTH = CONFIRMING_BAR_WIDTH + 4` so action bar doesn't wrap on normal terminals. Render-prop children receive the resolved `innerWidth` so child layout doesn't re-derive the widening math.

Height sync: first-pass estimate from content line counts; `useBoxMetrics` provides measured height. Mismatch → one extra render.

### Top border

Holds one `PillSegment` chain — risk badge (single pill, right-aligned) or wizard breadcrumbs (multi-pill, left-aligned). Nerd mode wraps the chain with Powerline curves and flames between segments; plain mode butts padded bg pills. Border tries full labels, falls back to each segment's `labelNarrow`, drops the chain if neither fits. Per-glyph gradient colors across the rule. Risk pills live in `risk-presets.ts`; wizard pills in `wizard-chrome.ts`; primitive in `pill.tsx` (`pillSegments`, `pillWidth`).

### Bottom border

All dim. Optional status segment (spinner + chrome text during `processing-followup`) in near-white `#d2d2e1`. Falls back to plain border if status can't fit.

## Text input

`src/tui/text-input.tsx` — single component for both edit mode (command buffer) and compose mode (follow-up draft). Discriminated union of editable vs read-only props.

Keybindings: Ctrl+A/E (home/end), Ctrl+U/K (kill-to-start/end), Ctrl+Y (yank), Alt+B/F (word jump), Alt+Backspace (delete word).

Why custom: `ink-text-input` can't be styled with `backgroundColor` and lacks word-jump / kill-line.

## Action bar

Every dialog's bottom row renders through one component: `src/tui/action-bar.tsx`. Items are `{ glyph, label, primary?, flashColor? }`. A single ASCII letter matching `label[0]` renders approve-style (underlined hotkey inside the label); anything else renders combo-style (`<glyph> <label>`). Items share a `" │ "` divider. `focusedIndex` is decoration only — ActionBar owns no keys. ActionBar renders items flush; callers wrap in `<Box paddingLeft={3}>` for the standard gutter. Optional `dividerAfter: readonly number[]` replaces the between-every-pair default with dividers only after the listed indices — ResponseDialog's confirming bar passes `[1]` to keep the primary/secondary group break. `flashColor` (approve-style only) tints both head and tail uniformly and drops the head's hotkey underline — used to flash a status word like `Copied` without conflating with a primary-action accent.

ResponseDialog's confirming bar: Yes/No/Edit/Follow-up + optionally Copy when a clipboard tool is resolvable (`src/core/clipboard.ts` sweeps `wl-copy`, `xclip`, `xsel`, `pbcopy`, `clip.exe` in declared order, module-cached). Hotkeys `y`/`n`/`e`/`f`/`c` come from `label[0]`; `q` and Ctrl+C also cancel. `←`/`→` navigate, `Enter` activates the focused item. Same bindings for every risk level — explicit selection + confirmation model provides sufficient safety.

Copy is dialog-local: it never reaches the reducer. Pressing `c` pipes the command to the clipboard binary and flashes the label to `Copied` for 2.5s; the timer resets on re-press and clears on transitions out of confirming. The write strips any trailing `\n` run (paste-to-shell auto-execute footgun) and is non-blocking — `proc.unref()` immediately, no `await proc.exited`, all errors swallowed. A hung `xclip` or `clip.exe` cannot wedge the dialog or block process exit.

## Input handling

One hook: `src/tui/key-bindings.ts`. Dialogs declare `{ on: trigger, do: callback }` lists and call `useKeyBindings(bindings, { isActive })`. Triggers are NamedKey strings (`return`, `escape`, `up`, …), single chars (case-insensitive, blocked by ctrl/meta), or `{ key, ctrl?, shift?, meta? }` objects for exact modifier combos. First match in declaration order wins.

ResponseDialog gates its confirming bindings by `state.tag === "confirming"` and its Esc binding by the other editing/composing-followup/processing-followup/executing-step tags. Printable keys in editing/composing-followup go through TextInput's own input path.

## Dialog states

| Tag | Content | Bottom slot |
|---|---|---|
| `confirming` | command, explanation | action bar |
| `editing` | editable TextInput | `⏎ to run, Esc to discard` |
| `composing-followup` | command, explanation, follow-up TextInput | `⏎ to send, Esc to discard` |
| `processing-followup` | command, explanation, follow-up (read-only) | `Esc to cancel` + border spinner |
| `executing-step` | spinner, previous output | step status |

## Decisions

- **3-column layout over Ink borderStyle.** Enables per-glyph gradient and in-border badge.
- **Single TextInput, not two components.** Editing and composing-followup must match visually. Discriminated union makes read-only path skip `useInput`.
- **Lazy-loaded, not tree-shaken.** Dynamic import is simpler and sufficient for a run-once CLI.
- **Alt-screen for dialog.** Protects scrollback from Ink re-render artifacts.
- **`describe` action (planned) must not consume a round.** It's an explanation side-channel, not part of the command-generation loop.
