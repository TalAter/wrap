import { Box, type DOMElement, measureElement, Text, useInput, useStdin, useStdout } from "ink";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import stringWidth from "string-width";
import type { ActionId, AppEvent, AppState } from "../session/state.ts";
import {
  type BorderSegment,
  bottomBorderSegments,
  interpolateGradient,
  topBorderSegments,
} from "./border.ts";
import { useSpinner } from "./spinner.ts";
import { TextInput } from "./text-input.tsx";

type DialogProps = {
  state: AppState;
  dispatch: (event: AppEvent) => void;
};

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
] as const satisfies ReadonlyArray<{
  id: ActionId;
  label: string;
  primary: boolean;
  hotkey: string;
}>;
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

/** Border status shown while a follow-up call is in flight before any chrome event arrives. */
export const FOLLOWUP_FALLBACK_STATUS = "Reticulating splines...";

export function Dialog({ state, dispatch }: DialogProps) {
  const { columns: termCols, rows: termRows } = useRenderSize();
  // Local presentation state. Pure UI — no application state depends on it.
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset action-bar selection on transitions out of confirming so the user
  // never sees a stale highlight when re-entering.
  useEffect(() => {
    if (state.tag !== "confirming") setSelectedIndex(0);
  }, [state.tag]);

  // Drain any buffered stdin on first mount and on every transition. The
  // reducer model fixes the case where a stray key lands in the wrong tag,
  // but it does NOT fix the case where the user pressed Enter while waiting
  // for the LLM and the keystroke is buffered in stdin BEFORE the dialog
  // mounts. Without the drain, that buffered Enter reaches Ink's `useInput`
  // on the very first frame and gets dispatched as `key-action run` against
  // `confirming`, executing a dangerous command the user never confirmed.
  const { stdin } = useStdin();
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.tag is a transition marker
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
  }, [state.tag, stdin]);

  // Pull display values from state. Outside of dialog tags the dialog is not
  // mounted at all (the session decides), so these reads are always defined
  // when this code runs — but TypeScript doesn't know that, hence the guards.
  const dialogResponse = "response" in state ? state.response : undefined;
  const command = dialogResponse?.content ?? "";
  const riskLevel = dialogResponse?.risk_level ?? "low";
  const explanation = dialogResponse?.explanation ?? undefined;
  const draft = "draft" in state ? state.draft : "";
  const status = state.tag === "processing" ? state.status : undefined;

  // Width calculation
  const showFollowupInput = state.tag === "composing" || state.tag === "processing";
  const natural = Math.max(
    stringWidth(command),
    explanation ? stringWidth(explanation) : 0,
    showFollowupInput ? stringWidth(draft) : 0,
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
  const followupLines =
    showFollowupInput && innerWidth > 0
      ? Math.max(1, Math.ceil(stringWidth(` ${draft}`) / innerWidth))
      : 0;
  // First-pass estimate only. Wrapped content can change the real height
  // after Ink layout runs (useLayoutEffect below corrects via measureElement).
  const initialBorderCount =
    1 +
    cmdLines +
    (explLines > 0 ? 1 : 0) +
    explLines +
    (followupLines > 0 ? 1 : 0) +
    followupLines +
    1 +
    1 +
    1 +
    1;
  const [borderCount, setBorderCount] = useState(initialBorderCount);
  const middleRef = useRef<DOMElement>(null);

  useLayoutEffect(() => {
    const node = middleRef.current;
    if (!node) return;
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

  // Editing-mode Esc → discard back to confirming.
  useInput(
    (_input, key) => {
      if (key.escape) dispatch({ type: "key-esc" });
    },
    { isActive: state.tag === "editing" },
  );

  // Confirming-mode key handling: arrow nav (local), Enter on highlight,
  // hotkeys, and Esc → cancel.
  useInput(
    (input, key) => {
      if (key.escape) {
        dispatch({ type: "key-esc" });
        return;
      }
      // q is an alias for cancel that doesn't fit the hotkey table (not the
      // first letter of any label).
      if (input === "q") {
        dispatch({ type: "key-action", action: "cancel" });
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
        if (item) dispatch({ type: "key-action", action: item.id });
        return;
      }
      const hotkeyMatch = ACTION_ITEMS.find((a) => a.hotkey === input);
      if (hotkeyMatch) {
        dispatch({ type: "key-action", action: hotkeyMatch.id });
      }
    },
    { isActive: state.tag === "confirming" },
  );

  // Composing-mode Esc → confirming. (TextInput handles printable input.)
  useInput(
    (_input, key) => {
      if (key.escape) dispatch({ type: "key-esc" });
    },
    { isActive: state.tag === "composing" },
  );

  // Processing-mode Esc → composing (coordinator handles abort + transition).
  useInput(
    (_input, key) => {
      if (key.escape) dispatch({ type: "key-esc" });
    },
    { isActive: state.tag === "processing" },
  );

  const spinnerFrame = useSpinner(state.tag === "processing");
  const bottomStatus =
    state.tag === "processing"
      ? `${spinnerFrame ?? ""} ${status ?? FOLLOWUP_FALLBACK_STATUS}`
      : undefined;

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
            {state.tag === "editing" ? (
              <TextInput
                value={state.draft}
                onChange={(t) => dispatch({ type: "draft-change", text: t })}
                onSubmit={(t) => {
                  if (t.trim() === "") return;
                  dispatch({ type: "submit-edit", text: t });
                }}
              />
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
            {(state.tag === "composing" || state.tag === "processing") && (
              <>
                <Text> </Text>
                {state.tag === "composing" ? (
                  <TextInput
                    value={state.draft}
                    onChange={(t) => dispatch({ type: "draft-change", text: t })}
                    onSubmit={(t) => {
                      if (t.trim() === "") return;
                      dispatch({ type: "submit-followup", text: t });
                    }}
                    placeholder="actually..."
                  />
                ) : (
                  <TextInput value={state.draft} readOnly />
                )}
              </>
            )}
            <Text> </Text>
            <Text> </Text>
            {state.tag === "editing" ? (
              <KeyHints items={EDIT_HINTS} />
            ) : state.tag === "composing" ? (
              <KeyHints items={COMPOSE_HINTS} />
            ) : state.tag === "processing" ? (
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
