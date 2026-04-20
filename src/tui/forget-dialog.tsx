import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import { getTheme, themeHex } from "../core/theme.ts";
import {
  type Footprint,
  formatFootprint,
  type Unit,
} from "../subcommands/forget-footprint.ts";
import { Checklist, type ChecklistItem } from "./checklist.tsx";
import { Dialog } from "./dialog.tsx";

export type Footprints = {
  memory: Footprint;
  logs: Footprint;
  cache: Footprint;
  scratch: Footprint;
};

export type ForgetBucket = "memory" | "logs" | "cache" | "scratch";

type RowSpec = { value: ForgetBucket; name: string; unit: Unit };

const ROWS: RowSpec[] = [
  { value: "memory", name: "Memory", unit: "facts" },
  { value: "logs", name: "Logs", unit: "entries" },
  { value: "cache", name: "Cache", unit: "files" },
  { value: "scratch", name: "Temp files", unit: "dirs" },
];

const CONTENT_WIDTH = 52;

type Props = {
  footprints: Footprints;
  onSubmit: (values: string[]) => void;
  onCancel: () => void;
};

export function ForgetDialog({ footprints, onSubmit, onCancel }: Props) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set<string>(ROWS.map((r) => r.value)),
  );

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const items: ChecklistItem[] = ROWS.map((r) =>
    toItem(r, footprints[r.value]),
  );

  const toggle = (value: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const t = getTheme();
  const stops = t.gradient.riskHigh;

  return (
    <Dialog gradientStops={stops} naturalContentWidth={CONTENT_WIDTH}>
      <Box flexDirection="column">
        <Checklist
          items={items}
          checked={checked}
          allowEmptySubmit
          onToggle={toggle}
          onSubmit={onSubmit}
        />
        <Text> </Text>
        <Text color={themeHex(t.text.muted)}>
          {"   ↑↓ move · space toggle · enter forget · esc cancel"}
        </Text>
      </Box>
    </Dialog>
  );
}

/** Build the label string "Name   (detail)" padded so footprints right-align. */
function toItem(row: RowSpec, fp: Footprint): ChecklistItem {
  const detail = formatFootprint(row.unit, fp);
  const nameWidth = Math.max(...ROWS.map((r) => stringWidth(r.name)));
  const pad = " ".repeat(Math.max(2, nameWidth - stringWidth(row.name) + 4));
  return {
    type: "option",
    label: `${row.name}${pad}${detail}`,
    value: row.value,
  };
}
