---
name: theme
description: Color tokens, dark/light appearances, color depth detection, graceful degradation
Source: src/core/theme.ts, src/core/detect-appearance.ts, src/core/ansi.ts, src/tui/theme-context.tsx
Last-synced: 0a22f2a
---

# Theme

One central palette, two appearances (dark/light), graceful degradation across color depths. TUI components never hardcode hex.

## Tokens

Authored as 24-bit RGB tuples in a single role-organized type (text / chrome / interactive / select / badge / gradient). Downsampling happens at render time. Adding a token = adding a field and filling it in both the dark and light themes.

No cross-theme derivation — light is never computed from dark. Within a theme, two roles pointing at the same token is fine (semantic reuse).

Gradients are two OKLAB endpoints, interpolated. Tuning a gradient is editing two values; no hand-tuned stop arrays.

## Consuming

Non-Ink code resolves the active theme + color level at the render site. Ink components use a context hook. Hex passed to Ink must always be quantized first because Ink emits truecolor regardless of `FORCE_COLOR`. `@inkjs/ui` components with hardcoded colors need explicit theme remapping.

## Appearance detection

Resolution chain (first hit wins): env var → explicit config → disk cache (1h TTL) → synchronous OSC 11 probe (50ms) → default dark.

OSC 11 asks the terminal for background color and computes WCAG luminance. **Probe is synchronous, not fire-and-forget**: its raw-mode toggle would otherwise race with a concurrently-mounting Ink dialog and drop the terminal out of raw mode while Ink still thinks it's there, echoing keystrokes to the shell. Two-pass resolution in startup so the wizard and `--help` see a resolved appearance before config load, then config can override.

## Color depth

Standard precedence: `NO_COLOR` always wins → `FORCE_COLOR` → TTY check → `TERM`/`COLORTERM` heuristics. Output renderer picks truecolor / 256 / ANSI16 / none from the resolved level.

Below truecolor, gradients short-circuit to a solid color — quantizing interpolated colors to 16/256 produces chunky banding worse than no gradient.

## Decisions

- **Authored in truecolor, quantized on output.** One palette, not three.
- **No cross-theme derivation.** Explicit values prevent cascading surprises.
- **Two-stop OKLAB gradients.** Simple to author, smooth result.
- **OSC 11 probe is synchronous.** Must finish before any Ink dialog mounts — raw-mode cleanup races with Ink's stdin claim on the same tty.
- **`NO_COLOR` always wins.** No exceptions.
