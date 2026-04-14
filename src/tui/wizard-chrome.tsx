import { Text } from "ink";
import { getTheme, themeHex } from "../core/theme.ts";
import type { Badge } from "./border.ts";

export function getWizardStops() {
  const t = getTheme();
  return t.gradient.wizard;
}

export function getWizardBadge(): Badge {
  const t = getTheme();
  return {
    fg: t.status.info,
    bg: [
      Math.round(t.status.info[0] * 0.3 + t.gradient.dim[0] * 0.7),
      Math.round(t.status.info[1] * 0.3 + t.gradient.dim[1] * 0.7),
      Math.round(t.status.info[2] * 0.3 + t.gradient.dim[2] * 0.7),
    ],
    icon: "🧙",
    label: "setup wizard",
  };
}

export const WIZARD_CONTENT_WIDTH = 70;

type HintItem = { combo: string; label: string; primary?: boolean };

export function KeyHints({ items }: { items: readonly HintItem[] }) {
  const t = getTheme();
  const divider = themeHex(t.text.disabled);
  const highlight = themeHex(t.interactive.highlight);
  const secondary = themeHex(t.text.secondary);
  const muted = themeHex(t.text.muted);

  return (
    <Text>
      <Text>{"  "}</Text>
      {items.map((item, i) => (
        <Text key={item.combo}>
          {i > 0 ? <Text color={divider}>{"  │  "}</Text> : null}
          <Text bold color={item.primary ? highlight : secondary}>
            {item.combo}
          </Text>
          <Text color={muted}>{` ${item.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
