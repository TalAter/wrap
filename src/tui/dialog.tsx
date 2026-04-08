import { Box, type DOMElement, measureElement, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import stringWidth from "string-width";
import type { RiskLevel } from "../command-response.schema.ts";
import {
  type BorderSegment,
  bottomBorderSegments,
  interpolateGradient,
  topBorderSegments,
} from "./border.ts";
import { TextInput } from "./text-input.tsx";

type DialogProps = {
  initialCommand: string;
  initialRiskLevel: RiskLevel;
  initialExplanation?: string;
  onChoice: (choice: "run" | "cancel", command: string) => void;
};

const ACTION_ITEMS = [
  { label: "No", primary: true },
  { label: "Yes", primary: true },
  { label: "Describe", primary: false },
  { label: "Edit", primary: false },
  { label: "Follow-up", primary: false },
  { label: "Copy", primary: false },
] as const;
const ACTION_BAR_WIDTH = 61;
const MIN_INNER_WIDTH = ACTION_BAR_WIDTH + 4;
const DIALOG_MARGIN = 4;
const MIN_TOTAL_WIDTH = 5;

export function Dialog({
  initialCommand,
  initialRiskLevel,
  initialExplanation,
  onChoice,
}: DialogProps) {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useRenderSize();
  // Held as state so the follow-up flow can swap command/risk/explanation
  // in place without remounting the dialog (which would flicker the alt screen).
  const [command] = useState(initialCommand);
  const [riskLevel] = useState(initialRiskLevel);
  const [explanation] = useState(initialExplanation);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialCommand);

  // Width calculation
  const natural = Math.max(
    stringWidth(command),
    explanation ? stringWidth(explanation) : 0,
    MIN_INNER_WIDTH,
  );
  const maxWidth = Math.max(MIN_TOTAL_WIDTH, termCols - DIALOG_MARGIN);
  const totalWidth = Math.min(natural + 4, maxWidth);
  const innerWidth = totalWidth - 4;

  // Height: calculate from content (avoids measureElement feedback loops with Ink layout)
  const cmdLines =
    innerWidth > 0 ? Math.max(1, Math.ceil(stringWidth(` ${command}`) / innerWidth)) : 1;
  const explLines =
    explanation && innerWidth > 0
      ? Math.max(1, Math.ceil(stringWidth(explanation) / Math.max(1, innerWidth - 1)))
      : 0;
  // First-pass estimate only. Wrapped content can change the real height after Ink layout runs.
  const initialBorderCount = 1 + cmdLines + (explLines > 0 ? 1 : 0) + explLines + 1 + 1 + 1 + 1;
  const [borderCount, setBorderCount] = useState(initialBorderCount);
  const middleRef = useRef<DOMElement>(null);

  useEffect(() => {
    setBorderCount(initialBorderCount);
  }, [initialBorderCount]);

  useLayoutEffect(() => {
    const node = middleRef.current;
    if (!node) return;
    // The side borders must match Ink's actual wrapped layout, not our estimate above.
    const { height } = measureElement(node);
    if (height > 0 && height !== borderCount) {
      setBorderCount(height);
    }
  });

  const leftBorderLines = Array.from({ length: borderCount }, (_, index) => ({
    key: `left-${index}`,
    color: interpolateGradient(index, borderCount, riskLevel),
  }));
  const rightBorderLines = Array.from({ length: borderCount }, (_, index) => ({
    key: `right-${index}`,
  }));

  useInput(
    (_input, key) => {
      if (key.escape) {
        setEditing(false);
        setDraft(command);
      }
    },
    { isActive: editing },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onChoice("cancel", command);
        exit();
        return;
      }
      if (input === "e") {
        setEditing(true);
        return;
      }
      if (input === "y") {
        onChoice("run", command);
        exit();
        return;
      }
      if (input === "n" || input === "q") {
        onChoice("cancel", command);
        exit();
        return;
      }
      if (key.leftArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.rightArrow) {
        setSelectedIndex((i) => Math.min(ACTION_ITEMS.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const label = ACTION_ITEMS[selectedIndex]?.label;
        if (label === "Yes") {
          onChoice("run", command);
          exit();
        } else if (label === "No") {
          onChoice("cancel", command);
          exit();
        } else if (label === "Edit") {
          setEditing(true);
        }
        // Describe, Follow-up, Copy — no-op in phase 1
      }
    },
    { isActive: !editing },
  );

  const handleEditSubmit = (value: string) => {
    if (value.trim() === "") return;
    onChoice("run", value);
    exit();
  };

  return (
    <Box width={termCols} height={termRows} justifyContent="center" alignItems="center">
      <Box flexDirection="column" width={totalWidth}>
        <BorderLine segments={topBorderSegments(totalWidth, riskLevel)} />

        <Box flexDirection="row" alignItems="flex-start">
          <Box flexDirection="column" width={2}>
            {leftBorderLines.map((line) => (
              <Text key={line.key} color={line.color}>
                {"│ "}
              </Text>
            ))}
          </Box>

          <Box
            ref={middleRef}
            flexDirection="column"
            width={innerWidth}
            paddingTop={1}
            paddingBottom={1}
          >
            {editing ? (
              <TextInput value={draft} onChange={setDraft} onSubmit={handleEditSubmit} />
            ) : (
              <TextInput value={command} readOnly />
            )}
            {explanation && (
              <>
                <Text> </Text>
                <Box paddingLeft={1}>
                  <Text color="#87879b">{explanation}</Text>
                </Box>
              </>
            )}
            <Text> </Text>
            <Text> </Text>
            {editing ? <EditHint /> : <ActionBar selectedIndex={selectedIndex} />}
          </Box>

          <Box flexDirection="column" width={2}>
            {rightBorderLines.map((line) => (
              <Text key={line.key} color="#3c3c64">
                {" │"}
              </Text>
            ))}
          </Box>
        </Box>

        <BorderLine segments={bottomBorderSegments(totalWidth)} />
      </Box>
    </Box>
  );
}

function useRenderSize(): { columns: number; rows: number } {
  // Ink owns the render stream; rerender on resize from that stream.
  const { stdout } = useStdout();
  const fallbackColumns = 80;
  const fallbackRows = 24;
  const snapshot = useSyncExternalStore(
    (onChange) => {
      stdout.on("resize", onChange);

      return () => {
        stdout.off("resize", onChange);
      };
    },
    () => `${stdout.columns || fallbackColumns}:${stdout.rows || fallbackRows}`,
    () => `${fallbackColumns}:${fallbackRows}`,
  );

  const [columnsText, rowsText] = snapshot.split(":");
  const columns = Number(columnsText ?? fallbackColumns);
  const rows = Number(rowsText ?? fallbackRows);
  return { columns, rows };
}

function BorderLine({ segments }: { segments: BorderSegment[] }) {
  return (
    <Text>
      {segments.map((segment) => (
        <Text
          key={segment.key}
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

function EditHint() {
  return (
    <Text>
      <Text color="#d2d2e1">{"   "}</Text>
      <Text bold color="#f5c864">
        {"⏎"}
      </Text>
      <Text color="#73738c">{" to run"}</Text>
      <Text color="#414150">{"  │  "}</Text>
      <Text bold color="#aaaac3">
        {"Esc"}
      </Text>
      <Text color="#73738c">{" to discard changes"}</Text>
    </Text>
  );
}

function ActionBar({ selectedIndex }: { selectedIndex: number }) {
  return (
    <Text>
      <Text color="#d2d2e1">{"   Run command? "}</Text>
      {ACTION_ITEMS.map((item, i) => {
        const isSelected = i === selectedIndex;
        const accent = item.primary
          ? isSelected
            ? "#ffdc78"
            : "#f5c864"
          : isSelected
            ? "#c8c8e0"
            : "#aaaac3";
        const dimColor = isSelected ? "#ebe6fa" : "#73738c";
        const bg = isSelected ? "#372d50" : undefined;

        return (
          <Text key={item.label}>
            {i === 2 ? <Text color="#414150">{" │ "}</Text> : null}
            <Text backgroundColor={bg}>
              {" "}
              <Text bold underline color={accent}>
                {item.label[0]}
              </Text>
              <Text color={dimColor} bold={isSelected}>
                {item.label.slice(1)}
              </Text>{" "}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}
