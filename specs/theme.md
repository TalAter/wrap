# Theme

How colors work in Wrap: one central palette, two appearances (dark / light), graceful degradation across color depths. Every hex string rendered anywhere in the product flows from this system.

Code: `src/core/theme.ts`, `src/core/detect-appearance.ts`, `src/core/ansi.ts` (quantize + fgCode), `src/tui/theme-context.tsx`, `src/tui/border.ts`.

## Principles

1. **Colors are defined exactly once.** `ThemeTokens` in `theme.ts` is the single source of truth. TUI components never hardcode hex.
2. **Appearance is a theme axis. Color depth is not.** Dark and light are different palettes. 16/256/truecolor are handled at render time by quantization — not by duplicating palettes.
3. **Authored in truecolor.** All tokens are `[r, g, b]` tuples at 24-bit precision. Downsampling happens on output.
4. **Resolved once at boot, cached on a module singleton.** No React Context needed outside Ink; non-Ink callers read `getTheme()` directly.

## Token shape

```ts
type ThemeTokens = {
  text:        { primary, secondary, muted, disabled: Color };
  status:      { success, warning, error, info: Color };
  chrome:      { border, surface, accent, dim: Color };
  interactive: { cursor, selection, highlight: Color };
  gradient:    {
    wizard, riskLow, riskMed, riskHigh: [Color, Color]; // bright → dim endpoints
    dim: Color;
  };
};
```

Add a token by adding a field to the type and filling it in `DARK_THEME` + `LIGHT_THEME`. Never ship a component with a one-off hex.

### Gradients are two endpoints

OKLAB interpolation between two endpoints produces a smooth ramp; hand-tuned 4–6 stop arrays aren't needed. Tuning a gradient means editing two values.

## Consuming the theme

**Non-Ink code** (help renderer, chrome, ANSI output):
```ts
import { getTheme } from "../core/theme.ts";
const c = getTheme().status.error; // [r,g,b]
fgCode(...c, colorLevel());
```

**Ink components**: prefer `useTheme()` inside function components, `getTheme()` at module load is fine for helpers:
```ts
const theme = useTheme();
<Text color={themeHex(theme.text.muted)}>...</Text>
```

**Always use `themeHex(color)` when handing hex to Ink**, never `colorHex()`. Ink's `<Text color="#abc">` emits truecolor escapes regardless of `FORCE_COLOR`. `themeHex` quantizes to the current level's palette first; `colorHex` is pure formatting and doesn't.

## Appearance detection

Resolution chain (first hit wins, all steps are instant):

1. `WRAP_THEME` env var (`dark` | `light`)
2. `config.appearance` when it's `"dark"` or `"light"` (not `"auto"`)
3. Disk cache at `~/.wrap/cache/appearance.json` (1-hour TTL)
4. Default: `"dark"` — then fire OSC 11 query asynchronously for next run

OSC 11 (`\x1b]11;?\x07`) asks the terminal for its background color. We parse the `rgb:RRRR/GGGG/BBBB` response, compute WCAG relative luminance, and classify (`> 0.5` → light). The query runs in the background with a 100 ms timeout, never blocks boot. On success, the result is cached; on timeout, the default is NOT overwritten.

Supported terminals (confirmed): Ghostty, iTerm2, kitty, Alacritty, WezTerm, modern macOS Terminal.app. Unsupported terminals quietly fall back to the default.

Early theme set in `main.ts` runs before `ensureConfig()` so the wizard and `--help` both see the resolved appearance. A second pass after config load picks up `config.appearance` if it's explicit.

## Color depth

Level detection in `colorLevel()` (`src/core/output.ts`). Precedence:

1. `NO_COLOR` set → level 0 (always wins — no-color.org contract)
2. `FORCE_COLOR` set → parsed int, clamped to `[0, 3]`, non-numeric → 1
3. Not a TTY → 0
4. `TERM=dumb` → 0
5. `COLORTERM=truecolor|24bit` → 3
6. `TERM` ends in `-256color` → 2
7. Otherwise → 1

`FORCE_COLOR` overrides the TTY check (useful for CI, pipes). `NO_COLOR` beats `FORCE_COLOR` — the opt-out always wins.

### Graceful degradation

`fgCode(r, g, b, level)` handles ANSI output: truecolor at 3, nearest 256-cube index at 2, nearest ANSI16 at 1, empty string at 0. `quantizeColor(c, level)` returns the nearest representable RGB in the target palette (used by `themeHex`).

### Gradients at low depth

Interpolating between two colors and then quantizing each cell to 16 or 256 produces chunky banding — the opposite of a smooth gradient. So below truecolor, gradient rendering short-circuits to a single neutral color (`theme.text.primary` — near-white on dark, near-black on light).

- **Level 3**: smooth OKLAB interpolation, authored gradient visible
- **Level 1–2**: solid `theme.text.primary` for the whole border/logo
- **Level 0**: Ink strips color escapes; terminal default foreground

The help-screen shine animation also skips below level 3 since it relies on blending white into the ramp.

### Border parity

Dialog borders use the same color source on all four sides:
- Top / left: `interpolateGradient(i, total, stops)` — gradient or solid per level
- Right / bottom: `interpolateGradient(last, total, stops)` — the gradient's end stop at level 3, `text.primary` at level < 3

This keeps the frame coherent at every depth.

## Overrides

User-facing knobs:

| Variable / setting   | Values              | Effect                                    |
| -------------------- | ------------------- | ----------------------------------------- |
| `WRAP_THEME` env     | `dark` \| `light`   | Force appearance for this run             |
| `config.appearance`  | `auto` \| `dark` \| `light` | Persistent appearance, `auto` is default |
| `NO_COLOR` env       | any non-empty       | Disable color entirely                    |
| `FORCE_COLOR` env    | `0`–`3`             | Force color level, bypass TTY check       |
| `WRAP_NO_MOTION` env | any                 | Disable animations (orthogonal to color)  |

## Invariants

- Never hardcode a hex literal in a TUI component. Fails the lint spirit; breaks light-mode support.
- Always use `themeHex()` for hex handed to Ink. Never `colorHex()`.
- OSC 11 must never block boot. Default dark, detect async, cache for next run.
- `NO_COLOR` always wins. No exceptions.
- Gradients with more than two stops are not needed — OKLAB handles the ramp.
