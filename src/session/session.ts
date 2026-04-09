import {
  DEFAULT_MAX_CAPTURED_OUTPUT_CHARS,
  DEFAULT_MAX_PIPED_INPUT_CHARS,
  DEFAULT_MAX_ROUNDS,
} from "../config/config.ts";
import { getWrapHome } from "../core/home.ts";
import { type Notification, notifications, writeNotificationToStderr } from "../core/notify.ts";
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
import { verbose } from "../core/verbose.ts";
import type { ToolProbeResult } from "../discovery/init-probes.ts";
import { assemblePromptScaffold } from "../llm/context.ts";
import { formatProvider, type Provider, type ResolvedProvider } from "../llm/types.ts";
import { addRound, createLogEntry, type LogEntry } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import type { Memory } from "../memory/types.ts";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import { type DialogHost, mountDialog, preloadDialogModules } from "./dialog-host.ts";
import { reduce } from "./reducer.ts";
import { type AppEvent, type AppState, isDialogTag, type SessionOutcome } from "./state.ts";

export type SessionOptions = {
  memory?: Memory;
  cwd: string;
  resolvedProvider: ResolvedProvider;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  pipedInput?: string;
  maxRounds?: number;
  maxCapturedOutputChars?: number;
  maxPipedInputChars?: number;
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
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxCapturedOutput = options.maxCapturedOutputChars ?? DEFAULT_MAX_CAPTURED_OUTPUT_CHARS;
  const maxPipedInput = options.maxPipedInputChars ?? DEFAULT_MAX_PIPED_INPUT_CHARS;
  const memory = options.memory ?? {};

  const entry = createLogEntry({
    prompt,
    cwd: options.cwd,
    pipedInput: options.pipedInput,
    memory,
    provider: options.resolvedProvider,
    promptHash: PROMPT_HASH,
  });

  const scaffold = assemblePromptScaffold(
    {
      prompt,
      cwd: options.cwd,
      memory,
      tools: options.tools,
      cwdFiles: options.cwdFiles,
      pipedInput: options.pipedInput,
      piped: !process.stdout.isTTY,
    },
    maxPipedInput,
  );

  const transcript: Transcript = [];
  transcript.push({ kind: "user", text: scaffold.initialUserText });
  const loopState: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
  const model = formatProvider(options.resolvedProvider);
  const baseLoopOptions: Omit<LoopOptions, "signal" | "showSpinner"> = {
    cwd: options.cwd,
    wrapHome,
    model,
    maxRounds,
    maxCapturedOutput,
    pipedInput: options.pipedInput,
  };

  // Lazy-load Ink in parallel with the first LLM call so the await before
  // the first dialog mount is free in practice. A failed dynamic import
  // is captured here so syncDialog can surface it via dispatch instead of
  // hanging the session on an unhandled rejection.
  const inkReady = process.stderr.isTTY
    ? preloadDialogModules().catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        dispatch({ type: "loop-error", error: err });
        throw err;
      })
    : null;

  let state: AppState = { tag: "thinking" };
  // Wrapped in a single-key object so TypeScript doesn't narrow `dialogHost`
  // to `null` after the try block — closure assignments aren't tracked by
  // control-flow analysis but a property mutation is opaque to it.
  const hostRef: { current: DialogHost | null } = { current: null };
  let mountInProgress = false;
  let currentLoopAbort: AbortController | null = null;
  const buffered: Notification[] = [];

  const exitDeferred = Promise.withResolvers<SessionOutcome>();
  let exited = false;

  function flushBuffered(): void {
    while (buffered.length > 0) {
      const n = buffered.shift();
      if (n) writeNotificationToStderr(n);
    }
  }

  const dispatch = (event: AppEvent): void => {
    if (exited) return;
    // Pre-transition: side effects that must precede reduce().
    if (event.type === "key-esc" && state.tag === "processing") {
      currentLoopAbort?.abort();
    }
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    // Post-transition: side effects that follow from the new state.
    void syncDialog();
    if (state.tag === "exiting") {
      exited = true;
      exitDeferred.resolve(state.outcome);
      return;
    }
    if (state.tag === "processing") {
      // submit-followup just transitioned us. Push the user turn and reset
      // the budget; the previous candidate_command turn already lives in the
      // transcript (the loop pushed it before returning), so the LLM sees
      // [..., candidate, user]. No stripStaleInstructions, no JSON, no
      // message-history hygiene.
      transcript.push({ kind: "user", text: state.draft });
      loopState.budgetRemaining = maxRounds;
      void pumpLoop();
    }
  };

  async function syncDialog(): Promise<void> {
    const wantsDialog = isDialogTag(state.tag);

    if (wantsDialog && mountInProgress) return;

    if (wantsDialog && !hostRef.current) {
      mountInProgress = true;
      try {
        if (inkReady) await inkReady;
        hostRef.current = mountDialog({ state, dispatch });
      } finally {
        mountInProgress = false;
      }
      // Re-sync in case state transitioned during the await (e.g., the user
      // typed Esc while we were mounting). Subsequent recursion is sync from
      // here forward — host is now set.
      void syncDialog();
      return;
    }

    if (wantsDialog && hostRef.current) {
      hostRef.current.rerender({ state, dispatch });
      return;
    }

    if (!wantsDialog && hostRef.current) {
      // Unmount: exit alt screen, unmount Ink, then flush buffered
      // notifications. Order is load-bearing — flushed lines must land in
      // real scrollback, not the alt buffer that's about to disappear.
      hostRef.current.unmount();
      hostRef.current = null;
      flushBuffered();
    }
  }

  async function pumpLoop(): Promise<void> {
    const ctrl = new AbortController();
    currentLoopAbort = ctrl;
    let firstRoundComplete = true;
    const isInitialLoop = state.tag === "thinking";
    // Captured at entry time. The only path to pumpLoop from non-thinking
    // is the submit-followup post-transition hook, which lands us in
    // `processing` with the user's text in `state.draft`.
    const followupText = state.tag === "processing" ? state.draft : undefined;

    function handleLoopEvent(event: LoopEvent): void {
      switch (event.type) {
        case "round-complete":
          if (firstRoundComplete && followupText !== undefined) {
            event.round.followup_text = followupText;
          }
          firstRoundComplete = false;
          addRound(entry, event.round);
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
      const generator = runLoop(provider, transcript, scaffold, loopState, {
        ...baseLoopOptions,
        signal: ctrl.signal,
        showSpinner: isInitialLoop,
      });
      let final: LoopReturn | undefined;
      while (true) {
        const { value, done } = await generator.next();
        if (ctrl.signal.aborted) return;
        if (done) {
          final = value;
          break;
        }
        handleLoopEvent(value);
      }
      if (!ctrl.signal.aborted && final) {
        // No-TTY interception: a medium/high command can't be confirmed
        // without a dialog. Dispatch `block` instead so the reducer routes
        // to `exiting{blocked}`. Only intercept on the initial loop;
        // follow-up loops always have a dialog already mounted.
        if (
          final.type === "command" &&
          final.response.risk_level !== "low" &&
          isInitialLoop &&
          !process.stderr.isTTY
        ) {
          chrome(`Command requires confirmation (no TTY available): ${final.response.content}`);
          dispatch({ type: "block", command: final.response.content });
        } else {
          dispatch({ type: "loop-final", result: final });
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const err = e instanceof Error ? e : new Error(String(e));
      dispatch({ type: "loop-error", error: err });
    } finally {
      // Identity check: only clear if WE are still the active loop. A second
      // pumpLoop started during our drain may have set currentLoopAbort to
      // its own ctrl already.
      if (currentLoopAbort === ctrl) currentLoopAbort = null;
    }
  }

  // Notification listener.
  //
  //   No dialog mounted (`hostRef.current === null`): write directly to
  //   stderr. This is the path for `thinking`, `exiting`, and any state
  //   where the dialog hasn't mounted yet or has already unmounted.
  //
  //   Dialog mounted: buffer for replay after unmount. Without buffering,
  //   stderr writes during alt-screen would land in the alt buffer and
  //   disappear on exit. While in `processing`, chrome notifications are
  //   ALSO dispatched to the reducer for live border display.
  const unsubscribe = notifications.subscribe((n) => {
    if (hostRef.current === null) {
      writeNotificationToStderr(n);
      return;
    }
    buffered.push(n);
    if (state.tag === "processing" && n.kind === "chrome") {
      dispatch({ type: "notification", notification: n });
    }
  });

  function teardownDialog(): void {
    if (hostRef.current !== null) {
      hostRef.current.unmount();
      hostRef.current = null;
      flushBuffered();
    }
  }

  let exitCode = 1;
  try {
    void pumpLoop();
    const outcome = await exitDeferred.promise;
    // Unmount the dialog BEFORE running the run-side-effect so the alt
    // screen is gone when the exec'd command writes to inherited stdio.
    // The notification listener stays subscribed through finaliseOutcome so
    // verbose/chrome lines from the exec phase still route through the bus.
    teardownDialog();
    exitCode = await finaliseOutcome(outcome, entry, options.pipedInput);
  } finally {
    unsubscribe();
    // Defensive: only fires if `await exitDeferred.promise` itself threw
    // (currently unreachable — exitDeferred is only resolved by `dispatch`,
    // which is sync). Both happy and error paths tear down above this point;
    // this is cheap insurance against a future throw inside dispatch.
    teardownDialog();
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

async function finaliseOutcome(
  outcome: SessionOutcome,
  entry: LogEntry,
  pipedInput: string | undefined,
): Promise<number> {
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
      // Throw rather than return — main.ts catches and renders via chrome,
      // matching the original `runQuery` contract. The throw runs AFTER the
      // finally block writes the log entry, so the error round is on disk
      // with `outcome: "error"` regardless of what main.ts does next.
      entry.outcome = "error";
      throw new Error(outcome.message);
    case "run": {
      verbose("Executing command...");
      const stdinBlob =
        outcome.response.pipe_stdin && pipedInput ? new Blob([pipedInput]) : undefined;
      const exec = await executeShellCommand(outcome.command, {
        mode: "inherit",
        stdinBlob,
      });
      // In-place mutation: the round is already in entry.rounds (eager-logged).
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
