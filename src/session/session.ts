import { getConfig } from "../config/store.ts";
import { notifications } from "../core/notify.ts";
import { chrome } from "../core/output.ts";
import {
  type LoopEvent,
  type LoopOptions,
  type LoopReturn,
  type LoopState,
  runLoop,
} from "../core/runner.ts";
import { executeShellCommand } from "../core/shell.ts";
import type { Transcript } from "../core/transcript.ts";
import { truncateMiddle } from "../core/truncate.ts";
import { verbose } from "../core/verbose.ts";
import type { ToolProbeResult } from "../discovery/init-probes.ts";
import { getWrapHome } from "../fs/home.ts";
import { assemblePromptScaffold } from "../llm/context.ts";
import { formatProvider, type Provider, type ResolvedProvider } from "../llm/types.ts";
import { addRound, createLogEntry, type LogEntry } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import type { Memory } from "../memory/types.ts";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import { mountResponseDialog, preloadResponseDialogModules } from "./dialog-host.ts";
import { createNotificationRouter } from "./notification-router.ts";
import { reduce } from "./reducer.ts";
import { type AppEvent, type AppState, isDialogTag, type SessionOutcome } from "./state.ts";

export type SessionOptions = {
  memory?: Memory;
  cwd: string;
  resolvedProvider: ResolvedProvider;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  /** Absolute path to the materialized attached-input file. Absent when no input was piped. */
  attachedInputPath?: string;
  /** Size of the attached-input file in bytes. */
  attachedInputSize?: number;
  /** UTF-8 preview of the attached input (possibly truncated) for the prompt. */
  attachedInputPreview?: string;
  /** True when the preview was shortened from the full content. */
  attachedInputTruncated?: boolean;
};

/**
 * Run a single user query end-to-end. Returns the process exit code.
 * Caller is responsible for `process.exit()`.
 *
 * Replaces the old `runQuery`. Same external contract.
 */
export async function runSession(
  prompt: string,
  provider: Provider,
  options: SessionOptions,
): Promise<number> {
  const wrapHome = getWrapHome();
  const config = getConfig();
  const maxRounds = config.maxRounds;
  const maxCapturedOutput = config.maxCapturedOutputChars;
  const memory = options.memory ?? {};

  const entry = createLogEntry({
    prompt,
    cwd: options.cwd,
    attachedInputPreview: options.attachedInputPreview,
    attachedInputPath: options.attachedInputPath,
    attachedInputSize: options.attachedInputSize,
    memory,
    provider: options.resolvedProvider,
    promptHash: PROMPT_HASH,
  });

  const scaffold = assemblePromptScaffold({
    prompt,
    cwd: options.cwd,
    memory,
    tools: options.tools,
    cwdFiles: options.cwdFiles,
    attachedInputPath: options.attachedInputPath,
    attachedInputSize: options.attachedInputSize,
    attachedInputPreview: options.attachedInputPreview,
    attachedInputTruncated: options.attachedInputTruncated,
    piped: !process.stdout.isTTY,
  });

  const transcript: Transcript = [];
  transcript.push({ kind: "user", text: scaffold.initialUserText });
  const loopState: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
  const model = formatProvider(options.resolvedProvider);
  const baseLoopOptions: Omit<LoopOptions, "signal" | "showSpinner"> = {
    cwd: options.cwd,
    wrapHome,
    model,
  };

  // Kicked off in parallel with the first LLM call so the first-mount
  // await is free in practice. The .catch surfaces a failed dynamic import
  // as a session error instead of an unbounded hang on `exitDeferred`.
  const inkReady = process.stderr.isTTY
    ? preloadResponseDialogModules().catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        dispatch({ type: "loop-error", error: err });
        throw err;
      })
    : null;

  let state: AppState = { tag: "thinking" };
  let mountInProgress = false;
  let currentLoopAbort: AbortController | null = null;

  const router = createNotificationRouter({
    isDialogLive: () => state.tag === "processing" || state.tag === "executing-step",
    onDialogNotification: (n) => dispatch({ type: "notification", notification: n }),
  });

  const exitDeferred = Promise.withResolvers<SessionOutcome>();
  let exited = false;

  const dispatch = (event: AppEvent): void => {
    if (exited) return;
    // Esc on `processing` or `executing-step` aborts BEFORE the reducer
    // transitions, so any in-flight LLM call or capture-mode step is
    // cancelled even if its result was about to land.
    if (
      event.type === "key-esc" &&
      (state.tag === "processing" || state.tag === "executing-step")
    ) {
      currentLoopAbort?.abort();
    }
    const prevTag = state.tag;
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    void syncDialog();
    if (state.tag === "exiting") {
      exited = true;
      exitDeferred.resolve(state.outcome);
      return;
    }
    const entered = state.tag !== prevTag;
    if (entered && state.tag === "processing") {
      // submit-followup just landed. The previous `candidate_command` turn
      // is already in the transcript, so pushing a user turn here gives the
      // LLM `[..., candidate, user]` — no message-history hygiene needed.
      const followupText = state.draft;
      transcript.push({ kind: "user", text: followupText });
      loopState.budgetRemaining = maxRounds;
      startPumpLoop({ isInitialLoop: false, followupText });
    }
    if (entered && state.tag === "executing-step") {
      // submit-step-confirm hook: the user just confirmed a non-final
      // med/high step (or finished editing one). Capture its output,
      // emit step-output through the bus, push a confirmed_step turn,
      // reset budget, then re-enter pumpLoop for the next round.
      void runConfirmedStep(state.response);
    }
  };

  async function runConfirmedStep(
    response: import("../command-response.schema.ts").CommandResponse,
  ): Promise<void> {
    const ctrl = new AbortController();
    currentLoopAbort = ctrl;
    try {
      const exec = await executeShellCommand(response.content, { mode: "capture" });
      if (ctrl.signal.aborted) return;
      let stepOutput = exec.stdout;
      if (exec.stderr.trim()) {
        stepOutput += (stepOutput.trim() ? "\n" : "") + exec.stderr;
      }
      stepOutput = truncateMiddle(stepOutput, maxCapturedOutput);
      notifications.emit({ kind: "step-output", text: stepOutput });
      transcript.push({
        kind: "confirmed_step",
        response,
        output: stepOutput,
        exitCode: exec.exitCode,
      });
      loopState.budgetRemaining = maxRounds;
      startPumpLoop({ isInitialLoop: false, followupText: undefined });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const err = e instanceof Error ? e : new Error(String(e));
      dispatch({ type: "loop-error", error: err });
    }
  }

  async function syncDialog(): Promise<void> {
    const wantsDialog = isDialogTag(state.tag);
    const mounted = router.isDialogMounted();

    if (wantsDialog && mountInProgress) return;

    if (wantsDialog && !mounted) {
      mountInProgress = true;
      try {
        if (inkReady) await inkReady;
        router.setDialog(mountResponseDialog({ state, dispatch }));
      } finally {
        mountInProgress = false;
      }
      // State may have moved during the await (e.g. user Esc'd while we
      // were mounting). The recursive call is sync from here — host is set.
      void syncDialog();
      return;
    }

    if (wantsDialog && mounted) {
      router.getDialog()?.rerender({ state, dispatch });
      return;
    }

    if (!wantsDialog && mounted) {
      router.teardownDialog();
    }
  }

  function startPumpLoop(opts: { isInitialLoop: boolean; followupText: string | undefined }): void {
    const ctrl = new AbortController();
    currentLoopAbort = ctrl;
    void pumpLoop({
      provider,
      transcript,
      scaffold,
      loopState,
      baseLoopOptions,
      signal: ctrl.signal,
      isInitialLoop: opts.isInitialLoop,
      followupText: opts.followupText,
      onRound: (round) => addRound(entry, round),
      dispatch,
    });
  }

  const unsubscribe = router.subscribe();

  let exitCode = 1;
  try {
    startPumpLoop({ isInitialLoop: true, followupText: undefined });
    const outcome = await exitDeferred.promise;
    // Unmount before exec so the alt screen is gone when the inherited
    // stdio command writes. The listener stays subscribed so verbose/chrome
    // lines from the exec phase still route through the bus.
    router.teardownDialog();
    exitCode = await finaliseOutcome(outcome, entry);
  } finally {
    unsubscribe();
    router.teardownDialog();
    appendLogEntryIgnoreErrors(wrapHome, entry);
  }

  return exitCode;
}

function appendLogEntryIgnoreErrors(wrapHome: string, entry: LogEntry): void {
  try {
    appendLogEntry(wrapHome, entry);
  } catch {
    // Logging must never break the tool.
  }
}

type PumpLoopArgs = {
  provider: Provider;
  transcript: Transcript;
  scaffold: ReturnType<typeof assemblePromptScaffold>;
  loopState: LoopState;
  baseLoopOptions: Omit<LoopOptions, "signal" | "showSpinner">;
  signal: AbortSignal;
  isInitialLoop: boolean;
  /** Stamped on the first `round-complete` only — even if it's a probe
   *  and the command lands several rounds later. Lets the log reconstruct
   *  which user message kicked off which sequence. Undefined for the
   *  initial loop (attributed to `entry.prompt`). */
  followupText: string | undefined;
  onRound: (round: import("../logging/entry.ts").Round) => void;
  dispatch: (event: AppEvent) => void;
};

/**
 * Drain a `runLoop` generator and route its events back to the session via
 * `dispatch` (`loop-final` / `loop-error` / `block`).
 */
async function pumpLoop(args: PumpLoopArgs): Promise<void> {
  const { signal, isInitialLoop, followupText, onRound, dispatch } = args;
  let firstRoundComplete = true;

  function handleLoopEvent(event: LoopEvent): void {
    switch (event.type) {
      case "round-complete":
        if (firstRoundComplete && followupText !== undefined) {
          event.round.followup_text = followupText;
        }
        firstRoundComplete = false;
        onRound(event.round);
        return;
      case "step-running":
        notifications.emit({
          kind: "chrome",
          text: event.explanation,
          icon: event.icon,
        });
        return;
      case "step-output":
        notifications.emit({ kind: "step-output", text: event.text });
        return;
    }
  }

  try {
    const generator = runLoop(args.provider, args.transcript, args.scaffold, args.loopState, {
      ...args.baseLoopOptions,
      signal,
      showSpinner: isInitialLoop,
    });
    let final: LoopReturn | undefined;
    while (true) {
      const { value, done } = await generator.next();
      if (signal.aborted) return;
      if (done) {
        final = value;
        break;
      }
      handleLoopEvent(value);
    }
    if (final === undefined) return;
    // A medium/high command can't be confirmed without a dialog, and the
    // initial loop is the only one without a dialog already mounted. Yolo
    // has nothing to confirm — skip the gate.
    if (
      final.type === "command" &&
      final.response.risk_level !== "low" &&
      isInitialLoop &&
      !process.stderr.isTTY &&
      !getConfig().yolo
    ) {
      chrome(`Command requires confirmation (no TTY available): ${final.response.content}`);
      dispatch({ type: "block", command: final.response.content });
      return;
    }
    dispatch({ type: "loop-final", result: final });
  } catch (e) {
    if (signal.aborted) return;
    const err = e instanceof Error ? e : new Error(String(e));
    dispatch({ type: "loop-error", error: err });
  }
}

async function finaliseOutcome(outcome: SessionOutcome, entry: LogEntry): Promise<number> {
  switch (outcome.kind) {
    case "answer":
      console.log(outcome.content);
      entry.outcome = "success";
      return 0;
    case "exhausted":
      chrome(`Could not resolve the request within ${entry.rounds.length} rounds.`);
      entry.outcome = "max_rounds";
      return 1;
    case "blocked":
      entry.outcome = "blocked";
      return 1;
    case "cancel":
      entry.outcome = "cancelled";
      return 1;
    case "error":
      // Throw rather than return — main.ts catches and renders via chrome.
      // The throw runs AFTER the finally writes the log, so the failure
      // round is on disk regardless of what main.ts does next.
      entry.outcome = "error";
      throw new Error(outcome.message);
    case "run": {
      verbose(`Running: ${outcome.command}`);
      const exec = await executeShellCommand(outcome.command, { mode: "inherit" });
      // The round is the same reference held in `entry.rounds` (eager-logged
      // by pumpLoop), so this in-place mutation lands in the JSONL flush.
      outcome.round.exec_ms = exec.exec_ms;
      outcome.round.execution = {
        command: outcome.command,
        exit_code: exec.exitCode,
        shell: exec.shell,
      };
      verbose(`Command exited (${exec.exitCode})`);
      entry.outcome = exec.exitCode === 0 ? "success" : "error";
      return exec.exitCode;
    }
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`unhandled session outcome: ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}
