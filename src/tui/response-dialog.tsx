import { Box, Text, useAnimation, useInput, useStdin, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import stringWidth from "string-width";
import { getConfig } from "../config/store.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../core/spinner.ts";
import type { ThemeTokens } from "../core/theme.ts";
import { themeHex } from "../core/theme.ts";
import type { ActionId, AppEvent, AppState } from "../session/state.ts";
import { Dialog, dialogInnerWidth } from "./dialog.tsx";
import { Pill } from "./pill.tsx";
import { getRiskPreset } from "./risk-presets.ts";
import { InputFrame, TextInput } from "./text-input.tsx";
import { useTheme } from "./theme-context.tsx";

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

/** How many visual rows a single line occupies at the given text width. */
function visualRows(line: string, textWidth: number): number {
  const w = stringWidth(line);
  return w === 0 ? 1 : Math.ceil(w / textWidth);
}

export type CommandDisplay =
  | { kind: "full"; text: string }
  | { kind: "folded"; head: string; hiddenCount: number; tail: string };

/** Caller owns how to render the indicator — plain text, pill, etc. */
export function foldCommand(command: string, maxRows: number, textWidth: number): CommandDisplay {
  if (maxRows < 1 || textWidth < 1) return { kind: "full", text: command };
  const lines = command.split("\n");
  const total = lines.reduce((sum, line) => sum + visualRows(line, textWidth), 0);
  if (total <= maxRows) return { kind: "full", text: command };

  // Reserve 1 row for the fold indicator.
  const budget = maxRows - 1;
  if (budget < 1) return { kind: "folded", head: "", hiddenCount: lines.length, tail: "" };

  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;

  const headLines: string[] = [];
  let headUsed = 0;
  for (const line of lines) {
    const rows = visualRows(line, textWidth);
    if (headUsed + rows > headBudget) break;
    headLines.push(line);
    headUsed += rows;
  }

  const tailLines: string[] = [];
  let tailUsed = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const line = lines[i] as string;
    const rows = visualRows(line, textWidth);
    if (tailUsed + rows > tailBudget) break;
    tailLines.unshift(line);
    tailUsed += rows;
  }

  const hiddenCount = lines.length - headLines.length - tailLines.length;
  return {
    kind: "folded",
    head: headLines.join("\n"),
    hiddenCount,
    tail: tailLines.join("\n"),
  };
}

/** String form of foldCommand — kept for callers that want a flat string. */
export function truncateCommand(command: string, maxRows: number, textWidth: number): string {
  const r = foldCommand(command, maxRows, textWidth);
  if (r.kind === "full") return r.text;
  const indicator = `… ${r.hiddenCount} lines hidden`;
  return [r.head, indicator, r.tail].filter((s) => s.length > 0).join("\n");
}

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

function FoldedCommand({
  head,
  hiddenCount,
  tail,
  theme,
}: {
  head: string;
  hiddenCount: number;
  tail: string;
  theme: ThemeTokens;
}) {
  const textColor = themeHex(theme.text.primary);
  return (
    <InputFrame>
      <Box flexDirection="column">
        {head ? <Text color={textColor}>{head}</Text> : null}
        <Pill
          label={`${hiddenCount} lines hidden`}
          fg={theme.badge.fold.fg}
          bg={theme.badge.fold.bg}
        />
        {tail ? <Text color={textColor}>{tail}</Text> : null}
      </Box>
    </InputFrame>
  );
}

export function ResponseDialog({ state, dispatch }: ResponseDialogProps) {
  const theme = useTheme();
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

  // Width + height calculation — caller owns this since it knows what will render.
  const { columns: termCols, rows: termRows } = useWindowSize();
  const showFollowupInput = state.tag === "composing" || state.tag === "processing";
  const naturalContentWidth = Math.max(
    stringWidth(command),
    explanation ? stringWidth(explanation) : 0,
    plan ? stringWidth(plan) : 0,
    showFollowupInput ? stringWidth(draft) : 0,
    MIN_INNER_WIDTH,
  );

  const textWidth = dialogInnerWidth(termCols, naturalContentWidth) - 2; // -2 for InputFrame paddingX={1}

  // Compute rows consumed by non-command content so we know max command rows.
  // Borders (2) + padding (2) + blank lines before action bar (2) + action bar (1) = 7
  let chromeRows = 7;
  if (explanation) chromeRows += 1 + Math.max(1, Math.ceil(stringWidth(explanation) / textWidth));
  if (plan) chromeRows += 1 + Math.max(1, Math.ceil(stringWidth(`Plan: ${plan}`) / textWidth));
  if (outputSlot !== undefined) {
    const formatted = formatOutputSlot(outputSlot);
    const outputTextRows = formatted
      .split("\n")
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / textWidth) || 1), 0);
    chromeRows += 1 + outputTextRows + 1; // label + wrapped text + spacer
  }
  if (showFollowupInput) chromeRows += 1 + Math.max(1, Math.ceil(stringWidth(draft) / textWidth));
  const maxCommandRows = Math.max(3, termRows - chromeRows);

  // Fold command for display when it would overflow the terminal. Editing
  // mode always renders the raw command so the user can edit it in full.
  const folded =
    state.tag === "editing"
      ? ({ kind: "full", text: command } as const)
      : foldCommand(command, maxCommandRows, textWidth);

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

  const noAnimation = getConfig().noAnimation;
  const spinnerActive =
    !noAnimation && (state.tag === "processing" || state.tag === "executing-step");
  const { frame: spinnerIndex } = useAnimation({
    interval: SPINNER_INTERVAL,
    isActive: spinnerActive,
  });
  const spinnerFrame = spinnerActive
    ? (SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? null)
    : null;
  const prefix = spinnerFrame ? `${spinnerFrame} ` : "";
  const bottomStatus =
    state.tag === "processing"
      ? `${prefix}${status ?? FOLLOWUP_FALLBACK_STATUS}`
      : state.tag === "executing-step"
        ? `${prefix}${EXECUTING_STEP_STATUS}`
        : undefined;

  const preset = getRiskPreset(riskLevel);

  return (
    <Dialog
      gradientStops={preset.stops}
      top={{ segs: [preset.pill], align: "right" }}
      bottomStatus={bottomStatus}
      naturalContentWidth={naturalContentWidth}
    >
      {outputSlot !== undefined && (
        <>
          <Box paddingLeft={1}>
            <Text color={themeHex(theme.text.muted)}>Output:</Text>
          </Box>
          <Box paddingLeft={1}>
            <Text color={themeHex(theme.text.secondary)}>{formatOutputSlot(outputSlot)}</Text>
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
      ) : folded.kind === "full" ? (
        <TextInput value={folded.text} readOnly />
      ) : (
        <FoldedCommand
          head={folded.head}
          hiddenCount={folded.hiddenCount}
          tail={folded.tail}
          theme={theme}
        />
      )}
      {explanation && (
        <>
          <Text> </Text>
          <Box paddingLeft={1}>
            <Text color={themeHex(theme.text.muted)}>{explanation}</Text>
          </Box>
        </>
      )}
      {plan && (
        <>
          <Text> </Text>
          <Box paddingLeft={1}>
            <Text color={themeHex(theme.text.accent)}>Plan: {plan}</Text>
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
        <KeyHints items={EDIT_HINTS} theme={theme} />
      ) : state.tag === "composing" ? (
        <KeyHints items={COMPOSE_HINTS} theme={theme} />
      ) : state.tag === "processing" ? (
        <KeyHints items={PROCESS_HINTS} theme={theme} />
      ) : state.tag === "executing-step" ? (
        <KeyHints items={EXECUTING_STEP_HINTS} theme={theme} />
      ) : (
        <ActionBar selectedIndex={selectedIndex} theme={theme} />
      )}
    </Dialog>
  );
}

type HintItem = { combo: string; label: string; primary?: boolean };

function KeyHints({ items, theme }: { items: readonly HintItem[]; theme: ThemeTokens }) {
  const divider = themeHex(theme.text.disabled);
  const highlight = themeHex(theme.interactive.highlight);
  const secondary = themeHex(theme.text.secondary);
  const muted = themeHex(theme.text.muted);

  return (
    <Text>
      <Text>{"   "}</Text>
      {items.map((item, i) => (
        <Text key={item.combo}>
          {i > 0 ? <Text color={divider}>{"  │  "}</Text> : null}
          <Text bold color={item.primary ? highlight : secondary}>
            {item.combo}
          </Text>
          <Text color={muted}>{` ${item.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

function ActionBar({ selectedIndex, theme }: { selectedIndex: number; theme: ThemeTokens }) {
  const primary = themeHex(theme.text.primary);
  const divider = themeHex(theme.text.disabled);
  const highlight = themeHex(theme.interactive.highlight);
  const secondary = themeHex(theme.text.secondary);
  const muted = themeHex(theme.text.muted);
  const accentBg = themeHex(theme.chrome.accent);

  // Brighter variant for selected primary actions
  const highlightBright = themeHex([
    Math.min(255, theme.interactive.highlight[0] + 10),
    Math.min(255, theme.interactive.highlight[1] + 20),
    Math.min(255, theme.interactive.highlight[2] + 20),
  ]);

  return (
    <Text>
      <Text color={primary}>{"   Run command? "}</Text>
      {ACTION_ITEMS.map((item, i) => {
        const isSelected = i === selectedIndex;
        const accent = item.primary
          ? isSelected
            ? highlightBright
            : highlight
          : isSelected
            ? primary
            : secondary;
        const dimColor = isSelected ? themeHex(theme.text.primary) : muted;
        const bg = isSelected ? accentBg : undefined;

        return (
          <Text key={item.label}>
            {i === 2 ? <Text color={divider}>{" │ "}</Text> : null}
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
