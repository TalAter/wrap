import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type ChecklistItem =
  | { type: "option"; label: string; value: string }
  | { type: "header"; label: string };

type Props = {
  items: ChecklistItem[];
  checked: Set<string>;
  onToggle: (value: string) => void;
  onSubmit: (values: string[]) => void;
};

const CHECKED_COLOR = "#66cc88";
const CURSOR_COLOR = "#6699ff";

export function Checklist({ items, checked, onToggle, onSubmit }: Props) {
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
            <Box key={item.label} flexDirection="column">
              {i > 0 && <Text> </Text>}
              <Text bold dimColor>
                {"  "}
                {item.label}
              </Text>
            </Box>
          );
        }
        const isFocused = i === cursorIndex;
        const isChecked = checked.has(item.value);
        const pointer = isFocused ? "❯" : " ";
        const indicator = isChecked ? "✓" : "·";
        return (
          <Text key={item.value}>
            <Text color={isFocused ? CURSOR_COLOR : undefined}>{pointer} </Text>
            <Text color={isChecked ? CHECKED_COLOR : "#73738c"}>{indicator} </Text>
            <Text color={isFocused ? CURSOR_COLOR : isChecked ? CHECKED_COLOR : undefined}>
              {item.label}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
