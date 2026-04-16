---
name: theme
description: Color tokens, dark/light appearances, color depth detection, graceful degradation
Source: src/core/theme.ts, src/core/detect-appearance.ts, src/core/ansi.ts, src/tui/theme-context.tsx
Last-synced: c54a1a5
---

# Theme

One central palette, two appearances (dark/light), graceful degradation across color depths.

## Token shape

`ThemeTokens` in `theme.ts` — single source of truth. Organized by role: `text` (primary/secondary/muted/disabled/accent), `chrome` (border/surface/accent/dim), `interactive` (cursor/selection/highlight), `select` (selected indicator), `badge` (per-type fg+bg), `gradient` (per-risk two-stop endpoints + dim).

All tokens are `[r, g, b]` tuples at 24-bit precision. Downsampling happens at render time.

Add a token by adding a field to the type and filling it in `DARK_THEME` + `LIGHT_THEME`. TUI components never hardcode hex.

No cross-theme derivation. Light is never computed from dark. Within a theme, pointing two surfaces at the same token is fine (semantic reuse).

Gradients are two OKLAB endpoints — smooth interpolation, no hand-tuned stop arrays. Tuning a gradient = editing two values.

## Consuming

- **Non-Ink** — `getTheme().text.accent` + `fgCode(...c, colorLevel())`.
- **Ink** — `useTheme()` in components, `getTheme()` in helpers.
- **Always `themeHex(color)` for hex handed to Ink**, never `colorHex()`. Ink emits truecolor regardless of `FORCE_COLOR`; `themeHex` quantizes first.

`@inkjs/ui` Select theming: `ThemeProvider` wraps children with `extendTheme(...)` mapping focus/selected/idle to theme tokens.

## Appearance detection

Resolution chain (first hit wins):

1. `WRAP_THEME` env var (`dark` | `light`)
2. `config.appearance` when explicit
3. Disk cache `~/.wrap/cache/appearance.json` (1h TTL)
4. Default `"dark"` — async OSC 11 query fires for next run

OSC 11 asks the terminal for background color, computes WCAG luminance, caches result. 100ms timeout, never blocks boot. Supported: Ghostty, iTerm2, kitty, Alacritty, WezTerm, modern Terminal.app.

Early theme set in `main.ts` runs before `ensureConfig()` so wizard and `--help` see resolved appearance. Second pass after config load picks up explicit `config.appearance`.

## Color depth

`colorLevel()` precedence: `NO_COLOR` → 0 (always wins), `FORCE_COLOR` → parsed/clamped, not-TTY → 0, `TERM=dumb` → 0, `COLORTERM=truecolor|24bit` → 3, `TERM` `-256color` → 2, otherwise → 1.

`fgCode(r,g,b,level)`: truecolor at 3, nearest 256-cube at 2, nearest ANSI16 at 1, empty at 0.

### Gradients at low depth

Quantizing interpolated colors to 16 or 256 produces chunky banding. Below truecolor, gradient rendering short-circuits to solid `theme.text.primary`. Help-screen shine animation also skips below level 3.

## Decisions

- **Authored in truecolor, quantized on output.** One palette, not three.
- **No cross-theme derivation.** Explicit values prevent cascading surprises.
- **Two-stop OKLAB gradients.** Simple to author, smooth result.
- **OSC 11 never blocks boot.** Default dark, detect async, cache for next run.
- **`NO_COLOR` always wins.** No exceptions. `FORCE_COLOR` overrides TTY check but not `NO_COLOR`.
- **Any inkjs-UI component with hardcoded color needs `extendTheme` treatment.** Select is handled; future components (Badge, Alert, etc.) need the same mapping.
