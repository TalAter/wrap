import {
  Box,
  type DOMElement,
  measureElement,
  Text,
  useApp,
  useInput,
  useStdin,
  useStdout,
} from "ink";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import stringWidth from "string-width";
import type { RiskLevel } from "../command-response.schema.ts";
import {
  type BorderSegment,
  bottomBorderSegments,
  interpolateGradient,
  topBorderSegments,
} from "./border.ts";
import { useSpinner } from "./spinner.ts";
import { TextInput } from "./text-input.tsx";

export type FollowupResult =
  | { type: "command"; command: string; riskLevel: RiskLevel; explanation?: string }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  | { type: "error"; message: string };

export type FollowupHandler = (text: string, signal: AbortSignal) => Promise<FollowupResult>;

// Terminal results emitted by the dialog itself. `blocked` lives on
// `DialogResult` (in render.ts) — it's only produced when there's no TTY,
// before the dialog mounts.
export type DialogOutput =
  | { type: "run"; command: string }
  | { type: "cancel"; command: string }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  | { type: "error"; message: string };

type DialogProps = {
  initialCommand: string;
  initialRiskLevel: RiskLevel;
  initialExplanation?: string;
  onResult: (result: DialogOutput) => void;
  onFollowup: FollowupHandler;
};

type DialogState = "confirming" | "editing-command" | "composing-followup" | "processing-followup";

// `id` is the stable handle for dispatch — labels are presentation only.
// Convention: hotkey is the lowercased first letter of `label` so the action
// bar can underline `label[0]` as the keybinding hint.
const ACTION_ITEMS = [
  { id: "cancel", label: "No", primary: true, hotkey: "n" },
  { id: "run", label: "Yes", primary: true, hotkey: "y" },
  { id: "describe", label: "Describe", primary: false, hotkey: "d" },
  { id: "edit", label: "Edit", primary: false, hotkey: "e" },
  { id: "followup", label: "Follow-up", primary: false, hotkey: "f" },
  { id: "copy", label: "Copy", primary: false, hotkey: "c" },
] as const;
type ActionId = (typeof ACTION_ITEMS)[number]["id"];
const ACTION_BAR_WIDTH = 61;
const MIN_INNER_WIDTH = ACTION_BAR_WIDTH + 4;
const DIALOG_MARGIN = 4;
const MIN_TOTAL_WIDTH = 5;

const EDIT_HINTS = [
  { combo: "⏎", label: "to run", primary: true },
  { combo: "Esc", label: "to discard changes" },
] as const;
const COMPOSE_HINTS = [
  { combo: "⏎", label: "to send", primary: true },
  { combo: "Esc", label: "to cancel" },
] as const;
const PROCESS_HINTS = [{ combo: "Esc", label: "to abort" }] as const;

export function Dialog({
  initialCommand,
  initialRiskLevel,
  initialExplanation,
  onResult,
  onFollowup,
}: DialogProps) {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useRenderSize();
  // Held as state so the follow-up flow can swap command/risk/explanation
  // in place without remounting the dialog (which would flicker the alt screen).
  const [command, setCommand] = useState(initialCommand);
  const [riskLevel, setRiskLevel] = useState(initialRiskLevel);
  const [explanation, setExplanation] = useState(initialExplanation);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dialogState, setDialogState] = useState<DialogState>("confirming");
  const [draft, setDraft] = useState(initialCommand);
  const [followupText, setFollowupText] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);

  // After a follow-up command swap, the next entry into editing-command must
  // show the swapped-in command, not the pre-swap text. Resyncing draft on
  // command change keeps them in lockstep without conflicting with edit-mode
  // typing (the user can only edit when command is stable).
  useEffect(() => {
    setDraft(command);
  }, [command]);

  // Drain any buffered stdin on state transitions. Without this, a stray
  // keypress from the previous mode (e.g. typed before the LLM responded)
  // could be processed by the new mode and accidentally advance the dialog.
  // tui-approach.md §3 lists this as critical for safety. dialogState is in
  // the deps as a transition marker even though the body doesn't read it —
  // re-firing on every state change is the entire point.
  const { stdin } = useStdin();
  // biome-ignore lint/correctness/useExhaustiveDependencies: dialogState is a transition marker
  useEffect(() => {
    try {
      // Bounded so a misbehaving stream that never returns null can't hang
      // the render. Real terminals never have more than a handful of bytes
      // queued; 1024 is generous insurance.
      for (let i = 0; i < 1024; i++) {
        if (stdin.read?.() === null) break;
      }
    } catch {
      // Test stdin streams may not implement read(); safe to ignore.
    }
  }, [dialogState, stdin]);

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
        setDialogState("confirming");
        setDraft(command);
      }
    },
    { isActive: dialogState === "editing-command" },
  );

  const performAction = (id: ActionId) => {
    if (id === "run") {
      onResult({ type: "run", command });
      exit();
    } else if (id === "cancel") {
      onResult({ type: "cancel", command });
      exit();
    } else if (id === "edit") {
      setDialogState("editing-command");
    } else if (id === "followup") {
      setDialogState("composing-followup");
    }
    // describe, copy — no-op in phase 1
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        performAction("cancel");
        return;
      }
      // q is an alias for cancel that doesn't fit the hotkey table (not the
      // first letter of any label).
      if (input === "q") {
        performAction("cancel");
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
        const item = ACTION_ITEMS[selectedIndex];
        if (item) performAction(item.id);
        return;
      }
      const hotkeyMatch = ACTION_ITEMS.find((a) => a.hotkey === input);
      if (hotkeyMatch) {
        performAction(hotkeyMatch.id);
      }
    },
    { isActive: dialogState === "confirming" },
  );

  // Composing follow-up: TextInput handles typing; parent only intercepts Esc.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setDialogState("confirming");
        setFollowupText("");
      }
    },
    { isActive: dialogState === "composing-followup" },
  );

  // Processing follow-up: Esc aborts the in-flight call and returns to
  // composing with the user's text preserved so they can refine it.
  useInput(
    (_input, key) => {
      if (key.escape) {
        abortControllerRef.current?.abort();
        setDialogState("composing-followup");
      }
    },
    { isActive: dialogState === "processing-followup" },
  );

  const handleEditSubmit = (value: string) => {
    if (value.trim() === "") return;
    onResult({ type: "run", command: value });
    exit();
  };

  const handleFollowupSubmit = async (text: string) => {
    if (text.trim() === "") return;
    setDialogState("processing-followup");
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let result: FollowupResult;
    try {
      result = await onFollowup(text, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return;
      onResult({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      exit();
      return;
    }
    // Stale result after Esc-abort: drop it; user is back in composing.
    if (controller.signal.aborted) return;
    if (result.type === "command") {
      setCommand(result.command);
      setRiskLevel(result.riskLevel);
      setExplanation(result.explanation);
      setFollowupText("");
      setDialogState("confirming");
      return;
    }
    onResult(result);
    exit();
  };

  const spinnerFrame = useSpinner(dialogState === "processing-followup");
  const bottomStatus =
    dialogState === "processing-followup" ? `${spinnerFrame ?? ""} Following up...` : undefined;

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
            {dialogState === "editing-command" ? (
              <TextInput value={draft} onChange={setDraft} onSubmit={handleEditSubmit} />
            ) : dialogState === "composing-followup" ? (
              <TextInput
                value={followupText}
                onChange={setFollowupText}
                onSubmit={handleFollowupSubmit}
                placeholder="actually..."
              />
            ) : dialogState === "processing-followup" ? (
              <TextInput value={followupText} readOnly />
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
            {dialogState === "editing-command" ? (
              <KeyHints items={EDIT_HINTS} />
            ) : dialogState === "composing-followup" ? (
              <KeyHints items={COMPOSE_HINTS} />
            ) : dialogState === "processing-followup" ? (
              <KeyHints items={PROCESS_HINTS} />
            ) : (
              <ActionBar selectedIndex={selectedIndex} />
            )}
          </Box>

          <Box flexDirection="column" width={2}>
            {rightBorderLines.map((line) => (
              <Text key={line.key} color="#3c3c64">
                {" │"}
              </Text>
            ))}
          </Box>
        </Box>

        <BorderLine segments={bottomBorderSegments(totalWidth, bottomStatus)} />
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

type HintItem = { combo: string; label: string; primary?: boolean };

function KeyHints({ items }: { items: readonly HintItem[] }) {
  return (
    <Text>
      <Text color="#d2d2e1">{"   "}</Text>
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
