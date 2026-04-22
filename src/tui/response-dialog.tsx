import { Box, Text, useAnimation, useStdin, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { getConfig } from "../config/store.ts";
import { resolveEditor, spawnEditor } from "../core/editor.ts";
import { registerExitTeardown, SPINNER_FRAMES, SPINNER_INTERVAL } from "../core/spinner.ts";
import type { ThemeTokens } from "../core/theme.ts";
import { themeHex } from "../core/theme.ts";
import type { ActionId, AppEvent, AppState } from "../session/state.ts";
import { ActionBar, type ActionItem } from "./action-bar.tsx";
import { Dialog, dialogInnerWidth } from "./dialog.tsx";
import { type KeyBinding, useKeyBindings } from "./key-bindings.ts";
import { Pill } from "./pill.tsx";
import { getRiskPreset } from "./risk-presets.ts";
import { InputFrame, TextInput } from "./text-input.tsx";
import { useTheme } from "./theme-context.tsx";

type ResponseDialogProps = {
  state: AppState;
  dispatch: (event: AppEvent) => void;
};

// `id` is the stable handle for dispatch — labels are presentation only.
// Hotkey is `label[0]` (case-insensitive), and ActionBar renders it underlined.
const CONFIRMING_ACTIONS = [
  { id: "cancel", label: "No", primary: true },
  { id: "run", label: "Yes", primary: true },
  { id: "edit", label: "Edit", primary: false },
  { id: "followup", label: "Follow-up", primary: false },
  { id: "copy", label: "Copy", primary: false },
] as const satisfies ReadonlyArray<{
  id: ActionId;
  label: string;
  primary: boolean;
}>;
const CONFIRMING_BAR_WIDTH = 61;
const MIN_INNER_WIDTH = CONFIRMING_BAR_WIDTH + 4;

const CONFIRMING_BAR_ITEMS: readonly ActionItem[] = CONFIRMING_ACTIONS.map((a) => ({
  glyph: (a.label[0] as string).toUpperCase(),
  label: a.label,
  primary: a.primary,
}));

function editAction(editor: ReturnType<typeof resolveEditor>): ActionItem | null {
  if (!editor) return null;
  return { glyph: "ctrl+G", label: `edit in ${editor.meta.displayName}` };
}

const EDIT_COMMAND_BASE_ACTIONS: readonly ActionItem[] = [
  { glyph: "⏎", label: "to run", primary: true },
  { glyph: "Esc", label: "to discard changes" },
];
const FOLLOWUP_COMPOSE_BASE_ACTIONS: readonly ActionItem[] = [
  { glyph: "⏎", label: "to send", primary: true },
  { glyph: "Esc", label: "to cancel" },
];
const PROCESSING_ACTIONS: readonly ActionItem[] = [{ glyph: "Esc", label: "to abort" }];
const EXECUTING_STEP_ACTIONS: readonly ActionItem[] = [{ glyph: "Esc", label: "to abort step" }];
const INTERACTIVE_COMPOSE_BASE_ACTIONS: readonly ActionItem[] = [
  { glyph: "⏎", label: "send", primary: true },
  { glyph: "Esc", label: "cancel" },
];

function appendEditorAction(
  base: readonly ActionItem[],
  editor: ReturnType<typeof resolveEditor>,
): readonly ActionItem[] {
  const edit = editAction(editor);
  if (!edit) return base;
  // Insert ctrl+G just before the final Esc so send/run stay first, edit-in-
  // $EDITOR comes next, Esc-cancel stays last.
  return [...base.slice(0, -1), edit, base[base.length - 1] as ActionItem];
}

const INTERACTIVE_PLACEHOLDERS = [
  "list all markdown files here",
  "delete all .DS_Store files in this project",
  "add .env to git ignore",
] as const;

function pickPlaceholder(previous?: string): string {
  // Different pick each time the buffer empties. Seed from Math.random but
  // avoid repeating the previous placeholder if possible.
  const pool = previous
    ? INTERACTIVE_PLACEHOLDERS.filter((p) => p !== previous)
    : INTERACTIVE_PLACEHOLDERS;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? INTERACTIVE_PLACEHOLDERS[0];
}

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

  // Kitty disambiguate mode: enable while we're composing so Shift+Enter /
  // Ctrl+letter combos report through useInput with proper modifier bits.
  // Drain ORDER: drain stdin first (below), then write the enable byte —
  // otherwise an in-flight paste's CSI bytes could be eaten by the drain,
  // or a keystroke pressed pre-mount could race the first render. The
  // disable byte writes on unmount; registerExitTeardown ensures the mode
  // is popped even if the process dies before unmount.
  useEffect(() => {
    if (state.tag !== "composing-interactive" && state.tag !== "composing-followup") {
      return;
    }
    if (!process.stderr.isTTY) return;
    const KITTY_ENABLE = "\x1b[>1u";
    const KITTY_DISABLE = "\x1b[<u";
    const unregister = registerExitTeardown(KITTY_DISABLE);
    process.stderr.write(KITTY_ENABLE);
    return () => {
      process.stderr.write(KITTY_DISABLE);
      unregister();
    };
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
  const status =
    state.tag === "processing-followup" || state.tag === "processing-interactive"
      ? state.status
      : undefined;
  const outputSlot = "outputSlot" in state ? state.outputSlot : undefined;
  const isInteractive =
    state.tag === "composing-interactive" || state.tag === "processing-interactive";

  const resolvedEditor = resolveEditor();

  const EDIT_COMMAND_ACTIONS_RESOLVED = appendEditorAction(
    EDIT_COMMAND_BASE_ACTIONS,
    resolvedEditor,
  );
  const FOLLOWUP_COMPOSE_ACTIONS_RESOLVED = appendEditorAction(
    FOLLOWUP_COMPOSE_BASE_ACTIONS,
    resolvedEditor,
  );
  const INTERACTIVE_COMPOSE_ACTIONS_RESOLVED = appendEditorAction(
    INTERACTIVE_COMPOSE_BASE_ACTIONS,
    resolvedEditor,
  );

  // Truncation banner lives under the input (per design: not in the border).
  // Parent-local: set when TextInput's onTruncate fires, cleared on next
  // keystroke (any onChange fires → effect resets it).
  const [truncatedBanner, setTruncatedBanner] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the keystroke signal that clears the banner
  useEffect(() => {
    setTruncatedBanner(false);
  }, [draft]);

  // Interactive-compose placeholder — one random pick on mount, and a fresh
  // pick every time the buffer goes from non-empty back to empty.
  const [placeholderText, setPlaceholderText] = useState<string>(() => pickPlaceholder());
  const prevDraftEmptyRef = useRef(draft === "");
  useEffect(() => {
    const nowEmpty = draft === "";
    if (nowEmpty && !prevDraftEmptyRef.current) {
      setPlaceholderText((prev) => pickPlaceholder(prev));
    }
    prevDraftEmptyRef.current = nowEmpty;
  }, [draft]);

  // Width + height calculation — caller owns this since it knows what will render.
  const { columns: termCols, rows: termRows } = useWindowSize();
  const showFollowupInput =
    state.tag === "composing-followup" || state.tag === "processing-followup";
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

  // Ctrl-G opens the user's external editor. GUI editors stay dialog-local:
  // we set `guiSpawn` so the TextInput renders `editingExternal`, run the
  // spawn in a useEffect below, and dispatch draft-change on return. Terminal-
  // owning editors dispatch enter-editor, which transitions the reducer to
  // editor-handoff — Ink unmounts, the coordinator runs the spawn, and
  // editor-done brings us back to this state with the new draft.
  const [guiSpawn, setGuiSpawn] = useState<null | { origin: AppState["tag"]; draft: string }>(null);
  const canOpenEditor =
    resolvedEditor !== null &&
    (state.tag === "composing-interactive" ||
      state.tag === "composing-followup" ||
      state.tag === "editing");
  useKeyBindings(
    [
      {
        on: { key: "g", ctrl: true },
        do: () => {
          if (!canOpenEditor || !resolvedEditor) return;
          const currentDraft = "draft" in state ? state.draft : "";
          if (resolvedEditor.meta.gui) {
            setGuiSpawn({ origin: state.tag, draft: currentDraft });
          } else {
            dispatch({ type: "enter-editor", draft: currentDraft });
          }
        },
      },
    ],
    { isActive: canOpenEditor && !guiSpawn },
  );

  // GUI editor spawn runs in the dialog, reducer-unaware. On completion,
  // dispatch draft-change (if text returned) and clear the local flag.
  useEffect(() => {
    if (!guiSpawn || !resolvedEditor) return;
    let cancelled = false;
    void (async () => {
      const newText = await spawnEditor(resolvedEditor, guiSpawn.draft);
      if (cancelled) return;
      if (newText !== null) dispatch({ type: "draft-change", text: newText });
      setGuiSpawn(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [guiSpawn, resolvedEditor, dispatch]);

  // Esc dispatches key-esc in every mode except confirming (which has its
  // own binding list below).
  useKeyBindings([{ on: "escape", do: () => dispatch({ type: "key-esc" }) }], {
    isActive:
      state.tag === "editing" ||
      state.tag === "composing-followup" ||
      state.tag === "processing-followup" ||
      state.tag === "composing-interactive" ||
      state.tag === "processing-interactive" ||
      state.tag === "executing-step",
  });

  // Confirming-mode key handling. Hotkeys derive from `label[0]` so renaming
  // a label re-routes its hotkey automatically. `cancel` also accepts `q` and
  // Ctrl+C; these extras are safe next to a bare `c` Copy binding because the
  // matcher blocks bare char triggers when any modifier is held.
  const dispatchAction = (id: ActionId) => dispatch({ type: "key-action", action: id });
  const hotkeyBindings: KeyBinding[] = CONFIRMING_ACTIONS.map((item) => {
    const hotkey = (item.label[0] as string).toLowerCase();
    return {
      on: item.id === "cancel" ? [hotkey, "q", { key: "c", ctrl: true }] : hotkey,
      do: () => dispatchAction(item.id),
    };
  });
  const confirmingBindings: KeyBinding[] = [
    { on: "escape", do: () => dispatch({ type: "key-esc" }) },
    ...hotkeyBindings,
    { on: "left", do: () => setSelectedIndex((i) => Math.max(0, i - 1)) },
    {
      on: "right",
      do: () => setSelectedIndex((i) => Math.min(CONFIRMING_ACTIONS.length - 1, i + 1)),
    },
    {
      on: "return",
      do: () => {
        const item = CONFIRMING_ACTIONS[selectedIndex];
        if (item) dispatchAction(item.id);
      },
    },
  ];
  useKeyBindings(confirmingBindings, { isActive: state.tag === "confirming" });

  const noAnimation = getConfig().noAnimation;
  const spinnerActive =
    !noAnimation &&
    (state.tag === "processing-followup" ||
      state.tag === "processing-interactive" ||
      state.tag === "executing-step");
  const { frame: spinnerIndex } = useAnimation({
    interval: SPINNER_INTERVAL,
    isActive: spinnerActive,
  });
  const spinnerFrame = spinnerActive
    ? (SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? null)
    : null;
  const prefix = spinnerFrame ? `${spinnerFrame} ` : "";
  const bottomStatus =
    state.tag === "processing-followup" || state.tag === "processing-interactive"
      ? `${prefix}${status ?? FOLLOWUP_FALLBACK_STATUS}`
      : state.tag === "executing-step"
        ? `${prefix}${EXECUTING_STEP_STATUS}`
        : undefined;

  const preset = getRiskPreset(riskLevel);

  if (isInteractive) {
    const lowPreset = getRiskPreset("low");
    // Chrome rows: 2 borders + 2 padding + 2 blank spacers + 1 action bar.
    // We cap maxRows below termRows - chromeRows so the dialog fits the screen.
    const interactiveChromeRows = 7 + (truncatedBanner ? 1 : 0);
    const maxRows = Math.max(3, termRows - interactiveChromeRows);
    const composeTheme = theme;
    return (
      <Dialog
        gradientStops={lowPreset.stops}
        top={{
          segs: [{ ...composeTheme.badge.riskLow, label: "compose", bold: true }],
          align: "left",
        }}
        bottomStatus={bottomStatus}
        naturalContentWidth={MIN_INNER_WIDTH}
      >
        {state.tag === "composing-interactive" ? (
          <TextInput
            value={state.draft}
            multiline
            maxRows={maxRows}
            editingExternal={guiSpawn !== null && guiSpawn.origin === "composing-interactive"}
            onChange={(t) => dispatch({ type: "draft-change", text: t })}
            onSubmit={(t) => {
              if (t.trim() === "") return;
              dispatch({ type: "submit-interactive", text: t });
            }}
            onTruncate={() => setTruncatedBanner(true)}
            placeholder={placeholderText}
          />
        ) : (
          <TextInput value={state.tag === "processing-interactive" ? state.draft : ""} readOnly />
        )}
        {truncatedBanner && (
          <Box paddingLeft={1}>
            <Text color={themeHex(composeTheme.text.muted)}>
              paste truncated — for large input, pipe with cat file | w
            </Text>
          </Box>
        )}
        <Text> </Text>
        <Text> </Text>
        <Box paddingLeft={3}>
          <ActionBar
            items={
              state.tag === "composing-interactive"
                ? INTERACTIVE_COMPOSE_ACTIONS_RESOLVED
                : PROCESSING_ACTIONS
            }
          />
        </Box>
      </Dialog>
    );
  }

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
          editingExternal={guiSpawn !== null && guiSpawn.origin === "editing"}
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
      {(state.tag === "composing-followup" || state.tag === "processing-followup") && (
        <>
          <Text> </Text>
          {state.tag === "composing-followup" ? (
            <TextInput
              value={state.draft}
              multiline
              maxRows={Math.max(3, termRows - chromeRows)}
              editingExternal={guiSpawn !== null && guiSpawn.origin === "composing-followup"}
              onChange={(t) => dispatch({ type: "draft-change", text: t })}
              onSubmit={(t) => {
                if (t.trim() === "") return;
                dispatch({ type: "submit-followup", text: t });
              }}
              onTruncate={() => setTruncatedBanner(true)}
              placeholder="actually..."
            />
          ) : (
            <TextInput value={state.draft} readOnly />
          )}
        </>
      )}
      <Text> </Text>
      <Text> </Text>
      <Box paddingLeft={3}>
        {state.tag === "editing" ? (
          <ActionBar items={EDIT_COMMAND_ACTIONS_RESOLVED} />
        ) : state.tag === "composing-followup" ? (
          <ActionBar items={FOLLOWUP_COMPOSE_ACTIONS_RESOLVED} />
        ) : state.tag === "processing-followup" ? (
          <ActionBar items={PROCESSING_ACTIONS} />
        ) : state.tag === "executing-step" ? (
          <ActionBar items={EXECUTING_STEP_ACTIONS} />
        ) : (
          <Text>
            <Text color={themeHex(theme.text.primary)}>{"Run command? "}</Text>
            <ActionBar
              items={CONFIRMING_BAR_ITEMS}
              focusedIndex={selectedIndex}
              dividerAfter={[1]}
            />
          </Text>
        )}
      </Box>
    </Dialog>
  );
}
