import { Text } from "ink";
import { getTheme, themeHex } from "../core/theme.ts";

export type ActionItem = {
  /**
   * Display glyph. A single ASCII letter (A–Z) matching `label[0]`
   * case-insensitively renders approve-style (underlined hotkey inside the
   * label, e.g. `Yes` with `Y` underlined). Anything else — non-ASCII letters,
   * multi-char tokens like `Esc`, glyph fonts like `⏎`, `↑↓` — renders as a
   * combo prefix: `<glyph> <label>`.
   */
  glyph: string;
  label: string;
  /** Highlight color on the glyph/letter — marks a first-tier action. */
  primary?: boolean;
};

type ActionBarProps = {
  items: readonly ActionItem[];
  /**
   * Visual-only. When set, the item at this index renders with the selection
   * highlight background. ActionBar owns no keys — arrow nav and Enter-on-focus
   * are wired by the caller's `useKeyBindings`.
   */
  focusedIndex?: number;
};

const LETTER_RE = /^[A-Za-z]$/;

function isApproveStyle(item: ActionItem): boolean {
  return (
    LETTER_RE.test(item.glyph) &&
    item.label.length > 0 &&
    (item.label[0] as string).toLowerCase() === item.glyph.toLowerCase()
  );
}

export function ActionBar({ items, focusedIndex }: ActionBarProps) {
  const t = getTheme();
  const primary = themeHex(t.text.primary);
  const divider = themeHex(t.text.disabled);
  const highlight = themeHex(t.interactive.highlight);
  const secondary = themeHex(t.text.secondary);
  const muted = themeHex(t.text.muted);
  const accentBg = themeHex(t.chrome.accent);
  const highlightBright = themeHex(t.interactive.highlightBright);

  return (
    <Text>
      <Text>{"   "}</Text>
      {items.map((item, i) => {
        const isFocused = focusedIndex === i;
        const bg = isFocused ? accentBg : undefined;
        const dividerNode = i > 0 ? <Text color={divider}>{"  │  "}</Text> : null;

        if (isApproveStyle(item)) {
          const accent = item.primary
            ? isFocused
              ? highlightBright
              : highlight
            : isFocused
              ? primary
              : secondary;
          const tail = isFocused ? primary : muted;
          const head = item.label[0] as string;
          const rest = item.label.slice(1);
          return (
            <Text key={`${item.glyph}:${item.label}`}>
              {dividerNode}
              <Text backgroundColor={bg}>
                {" "}
                <Text bold underline color={accent}>
                  {head}
                </Text>
                <Text color={tail} bold={isFocused}>
                  {rest}
                </Text>{" "}
              </Text>
            </Text>
          );
        }

        const glyphColor = item.primary ? highlight : secondary;
        return (
          <Text key={`${item.glyph}:${item.label}`}>
            {dividerNode}
            <Text backgroundColor={bg}>
              <Text bold color={glyphColor}>
                {item.glyph}
              </Text>
              <Text color={muted}>{` ${item.label}`}</Text>
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}
