import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import { resolveIcon } from "../core/output.ts";
import { getTheme, themeHex } from "../core/theme.ts";

export type ChecklistItem =
  | { type: "option"; label: string; value: string; icon?: string }
  | { type: "header"; label: string };

type Props = {
  items: ChecklistItem[];
  checked: Set<string>;
  /** Total visual width available for headers with dot leaders. */
  width?: number;
  onToggle: (value: string) => void;
  onSubmit: (values: string[]) => void;
};

const BRAILLE = "⠶";

export function Checklist({ items, checked, width, onToggle, onSubmit }: Props) {
  const t = getTheme();
  const CHECKED_COLOR = themeHex(t.select.selected);
  const DIM_COLOR = themeHex(t.text.muted);
  const CURSOR_COLOR = themeHex(t.interactive.cursor);
  const CURSOR_BG = themeHex(t.interactive.selection);

  const selectableIndices = items
    .map((item, i) => (item.type === "option" ? i : -1))
    .filter((i) => i >= 0);

  const [cursorPos, setCursorPos] = useState(0);
  const cursorIndex = selectableIndices[cursorPos] ?? 0;

  useInput((input, key) => {
    if (key.upArrow) {
      setCursorPos((p) => Math.max(0, p - 1));
    } else if (key.downArrow) {
      setCursorPos((p) => Math.min(selectableIndices.length - 1, p + 1));
    } else if (input === " ") {
      const item = items[cursorIndex];
      if (item?.type === "option") onToggle(item.value);
    } else if (key.return && checked.size > 0) {
      onSubmit([...checked]);
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        if (item.type === "header") {
          return (
            <SectionHeader key={item.label} label={item.label} width={width} spaceAbove={i > 0} />
          );
        }
        const isFocused = i === cursorIndex;
        const isChecked = checked.has(item.value);
        const tick = isChecked ? "[✓]" : "[ ]";
        const icon = item.icon ? resolveIcon(`${item.icon} `) : "";
        const checkbox = icon ? `${tick} ${icon}` : tick;
        const checkboxColor = isChecked ? CHECKED_COLOR : DIM_COLOR;
        const pointer = isFocused ? " ❯" : "  ";
        const rowText = `${pointer} ${checkbox} ${item.label}`;
        const pad = width ? Math.max(0, width - stringWidth(rowText)) : 0;

        return (
          <Text key={item.value} backgroundColor={isFocused ? CURSOR_BG : undefined}>
            <Text color={isFocused ? CURSOR_COLOR : undefined}>{pointer} </Text>
            <Text color={isFocused ? CURSOR_COLOR : checkboxColor}>{checkbox} </Text>
            <Text color={isFocused ? CURSOR_COLOR : isChecked ? CHECKED_COLOR : undefined}>
              {item.label}
            </Text>
            {isFocused && pad > 0 ? <Text>{" ".repeat(pad)}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function SectionHeader({
  label,
  width,
  spaceAbove,
}: {
  label: string;
  width?: number;
  spaceAbove: boolean;
}) {
  const leaderColor = themeHex(getTheme().chrome.dim);
  const showBraille = !width || width >= label.length + 8;
  const text = showBraille ? ` ${label.toUpperCase()} ` : label.toUpperCase();
  const trailWidth = showBraille && width ? width - text.length - 2 : 0;

  return (
    <Box flexDirection="column">
      {spaceAbove && <Text> </Text>}
      <Text>
        {showBraille && <Text color={leaderColor}>{BRAILLE.repeat(2)}</Text>}
        <Text bold dimColor>
          {text}
        </Text>
        {trailWidth > 0 && <Text color={leaderColor}>{BRAILLE.repeat(trailWidth)}</Text>}
      </Text>
    </Box>
  );
}
