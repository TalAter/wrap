import { Box, Text, useAnimation, useInput, useStdin } from "ink";
import { useEffect, useState } from "react";
import stringWidth from "string-width";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../core/spinner.ts";
import type { ActionId, AppEvent, AppState } from "../session/state.ts";
import { Dialog } from "./dialog.tsx";
import { RISK_PRESETS } from "./risk-presets.ts";
import { TextInput } from "./text-input.tsx";

type ResponseDialogProps = {
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

const EDIT_HINTS = [
  { combo: "⏎", label: "to run", primary: true },
  { combo: "Esc", label: "to discard changes" },
] as const;
const COMPOSE_HINTS = [
  { combo: "⏎", label: "to send", primary: true },
  { combo: "Esc", label: "to cancel" },
] as const;
const PROCESS_HINTS = [{ combo: "Esc", label: "to abort" }] as const;
const EXECUTING_STEP_HINTS = [{ combo: "Esc", label: "to abort step" }] as const;

/** Border status shown while a follow-up call is in flight before any chrome event arrives. */
export const FOLLOWUP_FALLBACK_STATUS = "Reticulating splines...";
/** Status shown while a confirmed non-final step is running in capture mode. */
export const EXECUTING_STEP_STATUS = "Running step...";
/** Sentinel rendered in the output slot when a step produced no output. */
export const OUTPUT_SLOT_EMPTY = "(no output)";
/** Number of trailing rows shown in the output slot. Spec pins this. */
const OUTPUT_SLOT_TAIL_ROWS = 3;

/**
 * Format a captured step body for the dialog's output slot: tail to the
 * last `OUTPUT_SLOT_TAIL_ROWS` lines, or render the empty sentinel when
 * the body is blank. Ink soft-wraps within the inner width, so we pass
 * rows as-is and let the layout handle wrapping.
 */
export function formatOutputSlot(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return OUTPUT_SLOT_EMPTY;
  const lines = trimmed.split("\n");
  if (lines.length <= OUTPUT_SLOT_TAIL_ROWS) return lines.join("\n");
  return lines.slice(-OUTPUT_SLOT_TAIL_ROWS).join("\n");
}

export function ResponseDialog({ state, dispatch }: ResponseDialogProps) {
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
  const plan = dialogResponse?.plan ?? undefined;
  const draft = "draft" in state ? state.draft : "";
  const status = state.tag === "processing" ? state.status : undefined;
  const outputSlot = "outputSlot" in state ? state.outputSlot : undefined;

  // Width calculation — caller owns this since it knows what will render.
  const showFollowupInput = state.tag === "composing" || state.tag === "processing";
  const naturalContentWidth = Math.max(
    stringWidth(command),
    explanation ? stringWidth(explanation) : 0,
    plan ? stringWidth(plan) : 0,
    showFollowupInput ? stringWidth(draft) : 0,
    MIN_INNER_WIDTH,
  );

  // Esc dispatches key-esc in every mode except confirming (which has its
  // own handler below with arrow nav, hotkeys, etc.).
  useInput(
    (_input, key) => {
      if (key.escape) dispatch({ type: "key-esc" });
    },
    {
      isActive:
        state.tag === "editing" ||
        state.tag === "composing" ||
        state.tag === "processing" ||
        state.tag === "executing-step",
    },
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

  const spinnerActive = state.tag === "processing" || state.tag === "executing-step";
  const { frame: spinnerIndex } = useAnimation({
    interval: SPINNER_INTERVAL,
    isActive: spinnerActive,
  });
  const spinnerFrame = spinnerActive
    ? (SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? null)
    : null;
  const bottomStatus =
    state.tag === "processing"
      ? `${spinnerFrame ?? ""} ${status ?? FOLLOWUP_FALLBACK_STATUS}`
      : state.tag === "executing-step"
        ? `${spinnerFrame ?? ""} ${EXECUTING_STEP_STATUS}`
        : undefined;

  const preset = RISK_PRESETS[riskLevel];

  return (
    <Dialog
      gradientStops={preset.stops}
      badge={preset.badge}
      bottomStatus={bottomStatus}
      naturalContentWidth={naturalContentWidth}
    >
      {outputSlot !== undefined && (
        <>
          <Box paddingLeft={1}>
            <Text color="#73738c">Output:</Text>
          </Box>
          <Box paddingLeft={1}>
            <Text color="#9a9ab4">{formatOutputSlot(outputSlot)}</Text>
          </Box>
          <Text> </Text>
        </>
      )}
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
      {plan && (
        <>
          <Text> </Text>
          <Box paddingLeft={1}>
            <Text color="#6f8fb4">Plan: {plan}</Text>
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
      ) : state.tag === "executing-step" ? (
        <KeyHints items={EXECUTING_STEP_HINTS} />
      ) : (
        <ActionBar selectedIndex={selectedIndex} />
      )}
    </Dialog>
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
