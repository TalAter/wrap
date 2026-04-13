import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Dialog } from "./dialog.tsx";
import { KeyHints, WIZARD_BADGE, WIZARD_CONTENT_WIDTH, WIZARD_STOPS } from "./wizard-chrome.tsx";

// Star Wars Nerd Font glyphs for detection
const TEST_ICONS = [
  "\u{F08D9}", // nf-md-death_star_variant
  "\uF1D0", // nf-fa-rebel
  "\uEDD6", // nf-fa-galactic_republic
  "\uF1D1", // nf-fa-empire
];

export type NerdIconsResult = { nerdFonts: boolean };

type NerdIconsSectionProps = {
  onDone: (result: NerdIconsResult) => void;
  onCancel: () => void;
};

export function NerdIconsSection({ onDone, onCancel }: NerdIconsSectionProps) {
  const [cursor, setCursor] = useState(0); // 0 = Yes, 1 = No

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.return) {
      onDone({ nerdFonts: cursor === 0 });
    } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      setCursor((c) => (c === 0 ? 1 : 0));
    }
  });

  const options = [
    "Yes — enable icons throughout Wrap",
    "No — they look like boxes or question marks",
  ];

  return (
    <Dialog
      gradientStops={WIZARD_STOPS}
      badge={WIZARD_BADGE}
      naturalContentWidth={WIZARD_CONTENT_WIDTH}
    >
      <Box flexDirection="column">
        <Text>Do you see four icons below?</Text>
        <Text> </Text>
        <Text>
          {"    "}
          {TEST_ICONS.join("  ")}
        </Text>
        <Text> </Text>
        {options.map((label, i) => (
          <Text key={label}>
            <Text color={i === cursor ? "#f5c864" : "#73738c"}>
              {i === cursor ? "  ❯ " : "    "}
            </Text>
            <Text color={i === cursor ? "#ffffff" : "#73738c"}>{label}</Text>
          </Text>
        ))}
        <Text> </Text>
        <KeyHints
          items={[
            { combo: "↑↓", label: "to move" },
            { combo: "⏎", label: "to select", primary: true },
          ]}
        />
      </Box>
    </Dialog>
  );
}
