import { Text } from "ink";
import type { Color } from "../core/ansi.ts";
import type { Badge } from "./border.ts";

export const WIZARD_STOPS: Color[] = [
  [120, 180, 255],
  [100, 150, 240],
  [90, 120, 210],
  [80, 100, 180],
  [70, 80, 150],
  [60, 60, 100],
];

export const WIZARD_BADGE: Badge = {
  fg: [180, 210, 255],
  bg: [30, 50, 90],
  icon: "🧙",
  label: "setup wizard",
};

export const WIZARD_CONTENT_WIDTH = 70;

type HintItem = { combo: string; label: string; primary?: boolean };

export function KeyHints({ items }: { items: readonly HintItem[] }) {
  return (
    <Text>
      <Text>{"  "}</Text>
      {items.map((item, i) => (
        <Text key={item.combo}>
          {i > 0 ? <Text color="#414150">{"  │  "}</Text> : null}
          <Text bold color={item.primary ? "#f5c864" : "#aaaac3"}>
            {item.combo}
          </Text>
          <Text color="#73738c">{` ${item.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
