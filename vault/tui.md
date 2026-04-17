---
name: tui
description: Ink dialog, three output tiers, custom borders, text input, action bar, host lifecycle
Source: src/tui/, src/session/dialog-host.ts, src/session/notification-router.ts
Last-synced: 4b44f55
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

Width: `min(max(natural, pillFullWidth - 2) + 4, termCols - 4)`. Dialog widens to fit the full top pill when the terminal allows. `MIN_INNER_WIDTH = ACTION_BAR_WIDTH + 4` so action bar doesn't wrap on normal terminals. Render-prop children receive the resolved `innerWidth` so child layout doesn't re-derive the widening math.

Height sync: first-pass estimate from content line counts; `useBoxMetrics` provides measured height. Mismatch → one extra render.

### Top border

Holds one `PillSegment` chain — risk badge (single pill, right-aligned) or wizard breadcrumbs (multi-pill, left-aligned). Nerd mode wraps the chain with Powerline curves and flames between segments; plain mode butts padded bg pills. Border tries full labels, falls back to each segment's `labelNarrow`, drops the chain if neither fits. Per-glyph gradient colors across the rule. Risk pills live in `risk-presets.ts`; wizard pills in `wizard-chrome.ts`; primitive in `pill.tsx` (`pillSegments`, `pillWidth`).

### Bottom border

All dim. Optional status segment (spinner + chrome text during `processing`) in near-white `#d2d2e1`. Falls back to plain border if status can't fit.

## Text input

`src/tui/text-input.tsx` — single component for both edit mode (command buffer) and compose mode (follow-up draft). Discriminated union of editable vs read-only props.

Keybindings: Ctrl+A/E (home/end), Ctrl+U/K (kill-to-start/end), Ctrl+Y (yank), Alt+B/F (word jump), Alt+Backspace (delete word).

Why custom: `ink-text-input` can't be styled with `backgroundColor` and lacks word-jump / kill-line.

## Action bar

`ACTION_ITEMS` const table of `{ id, label, primary, hotkey }`. Hotkeys: `y` run, `n`/`q`/`Esc` cancel, `d` describe, `e` edit, `f` follow-up, `c` copy. `←`/`→` navigate, `Enter` activates. Shortcut letter is bold + underlined.

Same keybindings for every risk level — dialog's explicit selection + confirmation model provides sufficient safety.

## Input handling

`useInput` gated by `{ isActive: state.tag === "<tag>" }`. Four handlers: confirming, editing, composing, processing. Printable keys in editing/composing go through TextInput.

## Dialog states

| Tag | Content | Bottom slot |
|---|---|---|
| `confirming` | command, explanation | action bar |
| `editing` | editable TextInput | `⏎ to run, Esc to discard` |
| `composing` | command, explanation, follow-up TextInput | `⏎ to send, Esc to discard` |
| `processing` | command, explanation, follow-up (read-only) | `Esc to cancel` + border spinner |
| `executing-step` | spinner, previous output | step status |

## Decisions

- **3-column layout over Ink borderStyle.** Enables per-glyph gradient and in-border badge.
- **Single TextInput, not two components.** Editing and composing must match visually. Discriminated union makes read-only path skip `useInput`.
- **Lazy-loaded, not tree-shaken.** Dynamic import is simpler and sufficient for a run-once CLI.
- **Alt-screen for dialog.** Protects scrollback from Ink re-render artifacts.
- **`describe` action (planned) must not consume a round.** It's an explanation side-channel, not part of the command-generation loop.
