import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type ChecklistItem =
  | { type: "option"; label: string; value: string }
  | { type: "header"; label: string };

type Props = {
  items: ChecklistItem[];
  checked: Set<string>;
  /** Total visual width available for headers with dot leaders. */
  width?: number;
  onToggle: (value: string) => void;
  onSubmit: (values: string[]) => void;
};

const CHECKED_COLOR = "#66cc88";
const CURSOR_COLOR = "#6699ff";
const CURSOR_BG = "#1a2a4d";
const LEADER_COLOR = "#484866";

const BRAILLE = "⠶";

export function Checklist({ items, checked, width, onToggle, onSubmit }: Props) {
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
          const label = ` ${item.label.toUpperCase()} `;
          const trailWidth = width ? width - label.length - 3 : 0;
          return (
            <Box key={item.label} flexDirection="column">
              {i > 0 && <Text> </Text>}
              <Text>
                <Text color={LEADER_COLOR}>{BRAILLE.repeat(2)}</Text>
                <Text bold dimColor>
                  {label}
                </Text>
                {trailWidth > 0 && <Text color={LEADER_COLOR}>{BRAILLE.repeat(trailWidth)}</Text>}
              </Text>
            </Box>
          );
        }
        const isFocused = i === cursorIndex;
        const isChecked = checked.has(item.value);
        const checkbox = isChecked ? "[✓]" : "[ ]";
        const pointer = isFocused ? " ❯" : "  ";
        const rowText = `${pointer} ${checkbox} ${item.label}`;
        const pad = width ? Math.max(0, width - rowText.length) : 0;

        return (
          <Text key={item.value} backgroundColor={isFocused ? CURSOR_BG : undefined}>
            <Text color={isFocused ? CURSOR_COLOR : undefined}>{pointer} </Text>
            <Text color={isChecked ? CHECKED_COLOR : "#73738c"}>{checkbox} </Text>
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
