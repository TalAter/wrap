# Confirmation Panel Implementation

Implementation plan for the styled confirmation panel. Visual design defined in `tui-approach.md` (section "Confirmation panel visual design") and `confirm-style.sh` (ANSI reference mockup).

## Architecture: 3-Column Layout

The panel is a vertical stack: top border, 3-column row, bottom border.

**Why this approach:** Ink's native `<Box borderStyle="round">` only supports a single border color — no gradient, no badge-in-border. Ink's `<Transform>` can't contain `<Box>` children (throws at runtime — Transform is a text node). The 3-column layout lets us use standard Ink components for all interior content (wrapping, flexbox, state) while rendering custom gradient borders as separate elements.

```tsx
<Box flexDirection="column" width={totalWidth}>
  <Text>{gradientTopBorder(totalWidth, riskLevel)}</Text>

  <Box flexDirection="row">
    {/* Left border: gradient │ per line */}
    <Box flexDirection="column" width={2}>
      {Array(borderCount).fill(0).map((_, i) => (
        <Text key={i} color={interpolateGradient(i, borderCount, riskLevel)}>│ </Text>
      ))}
    </Box>

    {/* Middle: full Ink layout, Ink handles all wrapping */}
    <Box ref={middleRef} flexDirection="column" flexGrow={1}>
      {/* command, explanation, action bar — see "Middle column content" */}
    </Box>

    {/* Right border: all dim */}
    <Box flexDirection="column" width={2}>
      {Array(borderCount).fill(0).map((_, i) => (
        <Text key={i} color="#3c3c64"> │</Text>
      ))}
    </Box>
  </Box>

  <Text>{gradientBottomBorder(totalWidth, riskLevel)}</Text>
</Box>
```

The middle column uses standard Ink components. Ink handles word-boundary wrapping for commands, explanations, and action bar automatically. No manual text wrapping.

The left and right border columns are arrays of `<Text>` elements (one per line). Left column carries the gradient (each `<Text>` gets a different hex color). Right column is all dim `[60,60,100]`.

### Width calculation

```ts
const ACTION_BAR_WIDTH = 57; // "Run command?  Yes  No  │  Describe  Edit  Follow-up  Copy"
const MIN_WIDTH = ACTION_BAR_WIDTH + 4; // border + padding
const natural = Math.max(stringWidth(command), stringWidth(explanation), MIN_WIDTH);
const totalWidth = Math.min(natural + 4, process.stderr.columns - 4);
```

`totalWidth` is set on the outer `<Box>`. Middle column gets `flexGrow={1}`, filling `totalWidth - 4`.

If the terminal is narrower than `MIN_WIDTH + 4` (~65 cols), the action bar wraps naturally — Ink handles this. The height sync re-render adjusts the borders to match.

### Height sync

The border columns need the same number of `│` characters as the middle column's rendered height.

```ts
const middleRef = useRef<DOMElement>(null); // DOMElement from ink
// 7 = empty + command + explanation + empty + empty + action bar + empty
const [borderCount, setBorderCount] = useState(7);

useEffect(() => {
  const { height } = measureElement(middleRef);
  if (height !== borderCount) setBorderCount(height);
}, [command, explanation, totalWidth]); // totalWidth changes on resize → content re-wraps
```

Common case: content doesn't wrap, 7 lines, no re-render. If content wraps on a narrow terminal, `useEffect` detects the mismatch and triggers one re-render. Ink replaces the frame (~33ms at 30fps default). Only the new `│` characters differ visually.

## Top and bottom borders

Pre-built ANSI strings rendered as `<Text>{string}</Text>` with no `color` prop (ANSI codes are embedded in the string). Built character-by-character using `fg()` from `ansi.ts` — do NOT use the `gradient()` helper, which skips spaces (the border has spaces around the badge pill that need coloring).

**Top border** with embedded risk badge:

```
╭─────────────────────────── ⚠ medium ──╮
```

Construction: iterate `totalWidth` characters. Each `─` and corner gets its color from `interpolateGradient(charIndex, totalWidth, riskLevel)` (left-to-right gradient, same palette as the left border but horizontal). The badge pill is inserted near the right end at position `totalWidth - badgeVisualWidth - 3` (3 = space + `─` + `╮`): tinted background + risk-colored bold text (badge colors per risk level defined in `tui-approach.md`). The `╭` at position 0 gets the brightest color; `╮` at the end gets the dim end color.

**Bottom border:**

```
╰───────────────────────────────────────╯
```

All dim end color `[60,60,100]` — the gradient has fully faded by the bottom.

### Gradient interpolation

Both borders and the left edge use the same function:

```ts
function interpolateGradient(index: number, total: number, riskLevel: "medium" | "high"): string {
  const t = total > 1 ? index / (total - 1) : 0; // 0..1
  const stops = riskLevel === "medium" ? MEDIUM_STOPS : HIGH_STOPS;
  const [r, g, b] = interpolate(stops, t); // reuse interpolate() from ansi.ts (currently private, export it)
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
```

For the left border: `index` = row index, `total` = borderCount. For the top border: `index` = char position, `total` = totalWidth.

## Middle column content

All standard Ink components. Ink handles layout and wrapping.

- **Command**: `<Text backgroundColor="#232332">` — tinted background strip spanning the full inner width. Ink's `backgroundColor` only colors behind text characters, so pad the command string with trailing spaces to fill the row: `command.padEnd(totalWidth - 4)` where `totalWidth - 4` is the middle column width. No syntax highlighting in phase 1.
- **Explanation**: `<Text color="#87879b">` — dimmer than body text (`rgb(135,135,155)` per mockup).
- **Empty lines**: `<Text> </Text>` for breathing room between sections.
- **Action bar**: See below.

## Action bar

Format: `Run command?  Yes  No  │  Describe  Edit  Follow-up  Copy`

Each action word has its shortcut letter styled **bold + underline + accent color**, rest of word is dim. Y/N use warm accent `#f5c864`, secondary keys (D/E/F/C) use cool accent `#aaaac3`. Dim text is `#73738c`. Separator `│` is `#414150`.

Action bar items are navigable with left/right arrow keys. Track `selectedIndex` in component state (default: 0 = Yes). The selected item gets brighter text or a subtle background tint. Pressing Enter activates the selected item (same as pressing its shortcut key). Each item is a `<Text>` with conditional styling based on whether it's selected.

## Gradient palettes

From `tui-approach.md` and `confirm-style.sh`:

**Medium risk** (pink → purple → dim):
```
[255,100,200] → [220,100,225] → [160,100,250] → [100,100,220] → [70,80,150] → [60,60,100]
```

**High risk** (red → purple → dim):
```
[255,60,80] → [230,65,130] → [185,75,190] → [125,85,210] → [80,80,155] → [60,60,100]
```

Left border interpolates through these stops top-to-bottom. Top border interpolates left-to-right. Right and bottom borders use the dim end color `[60,60,100]`.

## Input

Keep `useInput` for now. `tui-approach.md` warns about `useInput` + Bun (bun#6862), but that was written for Ink 5. Ink 6.8 rewrote `useInput` to use `useStdin` internally. Verify it works with Bun during implementation; switch to raw `useStdin` only if it doesn't.

Single-key bindings, same for both risk levels. This replaces the tiered keybinding scheme in SPEC.md (medium: Enter, high: y+Enter) — see `tui-approach.md` "Keybindings" section for rationale. SPEC.md should be updated to match.

| Key | Action |
|-----|--------|
| `y` | Run the command |
| `n`, `q`, `Esc` | Cancel |
| `d` | Describe — no-op in phase 1 (ignore keypress, no visual feedback) |
| `e` | Edit — no-op in phase 1 |
| `f` | Follow-up — no-op in phase 1 |
| `c` | Copy — no-op in phase 1 |
| `←` `→` | Navigate action bar |
| `Enter` | Activate selected action bar item |

## File structure

- **`src/tui/confirm.tsx`** — `ConfirmPanel` component (layout, state, input), `ActionBar` component
- **`src/tui/border.ts`** — `gradientTopBorder()`, `gradientBottomBorder()`, gradient color interpolation, risk palettes
- **`src/tui/render.ts`** — existing orchestration, minor type updates for new keybinding actions
- **`src/core/ansi.ts`** — export the existing `interpolate()` function and `Color` type (currently private). No new helpers needed — `underline()`, `bg()`, etc. are handled by Ink's `<Text>` props inside the component.

## Dependencies

- `string-width` — add as explicit dep (`bun add string-width`). Already an Ink transitive dep but importing transitive deps directly is fragile.
- `measureElement` — import from `ink` (e.g., `import { measureElement } from "ink"`).
- No other new deps in phase 1.

## Deferred to phase 2

- Syntax highlighting for commands (shell tokenizer)
- `d`/`e`/`f`/`c` handler implementations
- Keeping Ink mounted during LLM calls (describe/follow-up)
- Input buffer flush before rendering (safety feature from `tui-approach.md`)
