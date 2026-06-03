---
name: tui
description: Ink dialog, three output tiers, custom borders, text input, action bar
Source: src/tui/, src/session/dialog-host.ts, src/session/notification-router.ts
Last-synced: 4b5e321
---

# TUI

Ink 7 powers every interactive surface (confirmation dialog, [[wizard]], [[interactive-mode]]). Lazy-loaded — Ink + React + Yoga add ~1MB and 50–100ms; the common path (low-risk auto-exec) never pays. The first LLM call preloads dialog modules in parallel so they're warm by the time a dialog is needed.

The Ink/terminal mount mechanics live in **wrap-core** (`wrap-core/tui`: `renderDialog`, `openDialog`, `preloadDialogRuntime` — see `vault/wrap-core-api/tui.md`). Wrap owns the *content components* (`ResponseDialog`, `ConfigWizardDialog`, `ForgetDialog`) and the *session controller* that drives the live response dialog; it states intent (theme + content + what-to-do) and lets wrap-core own the mount, stdin/tty/fd handling, alt-screen options, and the `ThemeProvider` wrap. `src/session/dialog-host.ts` mounts the response dialog via `renderDialog(element, currentDialogTheme())` (the session drives `rerender`/`unmount`); the wizard and `[[forget]]` mount via `openDialog(currentDialogTheme(), (close) => element)` for the open-await-one-answer-close shape.

## Three output tiers

1. **Static chrome** — plain text to stderr.
2. **Animated chrome** — pre-Ink spinners using cursor control. Exists so "thinking…" doesn't force an Ink load. The spinner + raw stderr writers live in wrap-core (`wrap-core/chrome`); `src/core/spinner.ts` is a thin wrapper that injects wrap's `config.noAnimation` policy. See `vault/wrap-core-api/chrome.md`.
3. **Interactive UI** — Ink. Dialog, wizard, interactive mode.

## Ink configuration

wrap-core's `renderDialog` owns the terminal mechanics — alt-screen render to stderr (stdout stays clean per invariant 1; resize artifacts can't corrupt scrollback; unmount drops back to the main buffer with history intact), `exitOnCtrlC: false`, stdin/tty/fd selection, and cursor restore on unmount (works around a Bun bug that leaves the cursor hidden). See `vault/wrap-core-api/tui.md`. What stays wrap-side:

- **Stdin drain on mount and every state transition.** Lives in the response-dialog component, not the mount primitive — buffered keystrokes must never auto-confirm a dangerous command. Safety invariant — see [[session]].
- **Explicit Ctrl+C handling.** Because dialogs mount with `exitOnCtrlC: false`, each content component binds Ctrl+C itself (e.g. `ForgetDialog` → cancel).

## Dialog layout

Vertical stack with a custom 3-column middle row (left gradient border / content / right dim border). Custom because Ink's native border supports one color per side, and the top border carries in-border pills (risk badge, wizard breadcrumbs).

Width grows to fit the top pill chain when the terminal allows, with a minimum that prevents the action bar from wrapping. Children receive the resolved inner width so layout doesn't re-derive widening math.

Top border holds one pill chain — risk badge or wizard breadcrumbs. Nerd mode wraps with Powerline curves; plain mode butts padded bg pills. Falls back through narrow labels then drops the chain if neither fits. Bottom border is dim with an optional spinner+status segment for in-flight follow-up.

## Text input

Single component handles both edit (command buffer) and compose (follow-up / interactive draft) via a discriminated union. Custom because `ink-text-input` can't be styled with `backgroundColor` and lacks readline-style word-jump / kill-line. Multiline opt-in for compose surfaces — see [[interactive-mode]].

## Action bar

Every dialog's bottom row goes through one component. Items render approve-style (underlined hotkey letter) or combo-style (glyph + label) based on whether the label starts with a single ASCII letter. Shared divider between items; focus is decoration only — the bar owns no keys, the parent dialog wires them. Confirming bar adds a Copy item when a clipboard tool is available; copy is dialog-local (flashes label, no reducer event), failures silent.

## Input handling

One hook. Dialogs declare ordered `{ trigger, callback }` lists; first match wins. Triggers are named keys, single chars, or modifier-explicit objects. Bindings are gated by current dialog state so the same physical key does different things in confirming vs editing vs composing.

## Dialog states

`confirming` (action bar) · `editing` (TextInput, run/discard hint) · `composing-followup` (command + follow-up TextInput) · `processing-followup` (in-flight, border spinner) · `executing-step` (multi-step status). Compose tags for interactive mode: see [[interactive-mode]].

## Decisions

- **3-column layout over Ink borderStyle.** Enables per-glyph gradient and in-border pills.
- **Single TextInput.** Edit and compose must match visually; discriminated union keeps the read-only path off `useInput`.
- **Lazy-loaded, not tree-shaken.** Dynamic import is simpler and sufficient for a run-once CLI.
- **Alt-screen for dialog.** Protects scrollback from re-render artifacts.
