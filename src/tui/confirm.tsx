import { Box, measureElement, type DOMElement, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import {
  bottomBorderSegments,
  type BorderSegment,
  interpolateGradient,
  topBorderSegments,
} from "./border.ts";

type ConfirmPanelProps = {
  command: string;
  riskLevel: "medium" | "high";
  explanation?: string;
  onChoice: (choice: "run" | "cancel") => void;
};

const ACTION_LABELS = ["Yes", "No", "Describe", "Edit", "Follow-up", "Copy"] as const;
const ACTION_BAR_WIDTH = 57;
const MIN_INNER_WIDTH = ACTION_BAR_WIDTH + 4;

export function ConfirmPanel({ command, riskLevel, explanation, onChoice }: ConfirmPanelProps) {
  const { exit } = useApp();
  // Ink owns the render stream; size from that stream rather than process.stderr directly.
  const { stdout } = useStdout();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Width calculation
  const termCols = stdout.columns || 80;
  const natural = Math.max(
    stringWidth(command),
    explanation ? stringWidth(explanation) : 0,
    MIN_INNER_WIDTH,
  );
  const totalWidth = Math.min(natural + 4, termCols - 4);
  const innerWidth = totalWidth - 4;

  // Height: calculate from content (avoids measureElement feedback loops with Ink layout)
  const cmdLines =
    innerWidth > 0 ? Math.max(1, Math.ceil(stringWidth(` ${command}`) / innerWidth)) : 1;
  const explLines =
    explanation && innerWidth > 0
      ? Math.max(1, Math.ceil(stringWidth(`  ${explanation}`) / innerWidth))
      : 0;
  // First-pass estimate only. Wrapped content can change the real height after Ink layout runs.
  const initialBorderCount = 1 + cmdLines + explLines + 1 + 1 + 1 + 1;
  const [borderCount, setBorderCount] = useState(initialBorderCount);
  const middleRef = useRef<DOMElement>(null);

  useEffect(() => {
    setBorderCount(initialBorderCount);
  }, [initialBorderCount]);

  useEffect(() => {
    const node = middleRef.current;
    if (!node) return;
    // The side borders must match Ink's actual wrapped layout, not our estimate above.
    const { height } = measureElement(node);
    if (height > 0 && height !== borderCount) {
      setBorderCount(height);
    }
  }, [borderCount, command, explanation, innerWidth]);

  useInput((input, key) => {
    if (input === "y") {
      onChoice("run");
      exit();
      return;
    }
    if (input === "n" || input === "q" || key.escape) {
      onChoice("cancel");
      exit();
      return;
    }
    if (key.leftArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.rightArrow) {
      setSelectedIndex((i) => Math.min(ACTION_LABELS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const action = ACTION_LABELS[selectedIndex];
      if (action === "Yes") {
        onChoice("run");
        exit();
      } else if (action === "No") {
        onChoice("cancel");
        exit();
      }
      // Describe, Edit, Follow-up, Copy — no-op in phase 1
    }
  });

  const cmdPadded = ` ${command}`.padEnd(innerWidth);

  return (
    <Box flexDirection="column" width={totalWidth}>
      <BorderLine segments={topBorderSegments(totalWidth, riskLevel)} />

      <Box flexDirection="row" alignItems="flex-start">
        <Box flexDirection="column" width={2}>
          {Array.from({ length: borderCount }, (_, i) => (
            <Text key={`left-${i}`} color={interpolateGradient(i, borderCount, riskLevel)}>
              {"│ "}
            </Text>
          ))}
        </Box>

        <Box ref={middleRef} flexDirection="column" width={innerWidth}>
          <Text> </Text>
          <Text backgroundColor="#232332">{cmdPadded}</Text>
          {explanation && (
            <Text color="#87879b">
              {"  "}
              {explanation}
            </Text>
          )}
          <Text> </Text>
          <Text> </Text>
          <ActionBar selectedIndex={selectedIndex} />
          <Text> </Text>
        </Box>

        <Box flexDirection="column" width={2}>
          {Array.from({ length: borderCount }, (_, i) => (
            <Text key={`right-${i}`} color="#3c3c64">
              {" │"}
            </Text>
          ))}
        </Box>
      </Box>

      <BorderLine segments={bottomBorderSegments(totalWidth)} />
    </Box>
  );
}

function BorderLine({ segments }: { segments: BorderSegment[] }) {
  return (
    <Text>
      {segments.map((segment, i) => (
        <Text
          key={`${i}-${segment.text}`}
          color={segment.color}
          backgroundColor={segment.backgroundColor}
          bold={segment.bold}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function ActionBar({ selectedIndex }: { selectedIndex: number }) {
  const items = [
    { label: "Yes", primary: true },
    { label: "No", primary: true },
    { label: "Describe", primary: false },
    { label: "Edit", primary: false },
    { label: "Follow-up", primary: false },
    { label: "Copy", primary: false },
  ];

  return (
    <Text>
      <Text color="#d2d2e1">{"   Run command?  "}</Text>
      {items.map((item, i) => {
        const accent = item.primary ? "#f5c864" : "#aaaac3";
        const isSelected = i === selectedIndex;
        const dimColor = isSelected ? "#b0b0c8" : "#73738c";

        return (
          <Text key={item.label}>
            {i === 2 ? <Text color="#414150">{"  │  "}</Text> : i > 0 ? <Text>{"  "}</Text> : null}
            <Text bold underline color={accent}>
              {item.label[0]}
            </Text>
            <Text color={dimColor}>{item.label.slice(1)}</Text>
          </Text>
        );
      })}
    </Text>
  );
}
