import { getConfig } from "../config/store.ts";
import { resolveEditor, spawnEditor } from "../core/editor.ts";
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
import { assemblePromptScaffold } from "../llm/context.ts";
import { formatProvider, type Provider, type ResolvedProvider } from "../llm/types.ts";
import { createLogEntry, type LogEntry, type Turn } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import type { Memory } from "../memory/types.ts";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import { runSkills, type Skill } from "../skills/index.ts";
import { mountResponseDialog, preloadResponseDialogModules } from "./dialog-host.ts";
import { createNotificationRouter } from "./notification-router.ts";
import { reduce } from "./reducer.ts";
import { type AppEvent, type AppState, isDialogTag, type SessionOutcome } from "./state.ts";

export type SessionOptions = {
  memory?: Memory;
  cwd: string;
  resolvedProvider: ResolvedProvider;
  /**
   * Skills to run before the first LLM call on each user-prompt entry point
   * (argv at session start; `state.draft` on interactive submit). Their
   * emitted turn pairs are spliced in before the user turn so the user's
   * natural-language request stays the freshest message — the trust-fence
   * for false-positive trigger matches.
   */
  skills?: readonly Skill[];
  /** Absolute path to the materialized attached-input file. Absent when no input was piped. */
  attachedInputPath?: string;
  /** Size of the attached-input file in bytes. */
  attachedInputSize?: number;
  /** UTF-8 preview of the attached input (possibly truncated) for the prompt. */
  attachedInputPreview?: string;
  /** True when the preview was shortened from the full content. */
  attachedInputTruncated?: boolean;
  /** How the prompt arrived — main.ts decides, session records.
   *  Not overridden when the interactive composer kicks off from within
   *  the session, so callers that want "tui" for interactive bootstrap
   *  must pass it explicitly. */
  inputSource?: "argv" | "pipe" | "tui";
  /**
   * Set on a `-c` invocation. `assembledTurns` is the chronological
   * concat of every ancestor entry's `turns[]`.
   * `parentPrompt` is the chain root's original user prompt (drives the
   * `↳ Continuing` UX badge; unused outside the dialog).
   *
   * The session seeds `entry.turns` with `assembledTurns`, stamps
   * `entry.parent_id`, and lets the normal user-turn push from `prompt`
   * land at the tail of the seeded chain.
   */
  continuationParent?: {
    parentId: string;
    assembledTurns: Turn[];
    parentPrompt: string;
  };
};

/**
 * Run a single user query end-to-end. Returns the process exit code.
 * Caller is responsible for `process.exit()`.
 */
export async function runSession(
  prompt: string,
  provider: Provider,
  options: SessionOptions,
): Promise<number> {
  const config = getConfig();
  const maxRounds = config.maxRounds;
  const maxCapturedOutput = config.maxCapturedOutputChars;
  const memory = options.memory ?? {};

  const entry = createLogEntry({
    cwd: options.cwd,
    attachedInputPreview: options.attachedInputPreview,
    attachedInputPath: options.attachedInputPath,
    attachedInputSize: options.attachedInputSize,
    memory,
    provider: options.resolvedProvider,
    promptHash: PROMPT_HASH,
    inputSource: options.inputSource,
  });
  if (options.continuationParent) {
    entry.parent_id = options.continuationParent.parentId;
    entry.turns.push(...options.continuationParent.assembledTurns);
  }

  const buildScaffold = () =>
    assemblePromptScaffold({
      cwd: options.cwd,
      memory,
      attachedInputPath: options.attachedInputPath,
      attachedInputSize: options.attachedInputSize,
      attachedInputPreview: options.attachedInputPreview,
      attachedInputTruncated: options.attachedInputTruncated,
      piped: !process.stdout.isTTY,
    });

  // Interactive mode: no args + TTY means the user has not typed a prompt yet.
  // The dialog's `composing-interactive` state is the entry point; the
  // transcript stays empty until submit so we don't send an unqualified
  // context blurb to the LLM.
  const isInteractiveBootstrap = prompt === "" && process.stdin.isTTY === true;
  const scaffold = buildScaffold();

  // The transcript IS entry.turns — one shape, two consumers.
  const transcript: Transcript = entry.turns;
  if (!isInteractiveBootstrap) {
    await seedFirstUserTurn(options.skills, prompt, transcript);
  }
  const loopState: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
  const model = formatProvider(options.resolvedProvider);
  // Thunk — `scaffold` is reassigned on interactive bootstrap, so each pump
  // captures the current scaffold's contextString rather than the one that
  // existed at session start.
  const makeBaseLoopOptions = (): Omit<LoopOptions, "signal" | "showSpinner"> => ({
    cwd: options.cwd,
    model,
    requestFraming: {
      contextString: scaffold.contextString,
      sectionUserRequest: scaffold.sectionUserRequest,
    },
  });

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

  let state: AppState = isInteractiveBootstrap
    ? { tag: "composing-interactive", draft: "" }
    : { tag: "thinking" };
  let mountInProgress = false;
  let currentLoopAbort: AbortController | null = null;

  const router = createNotificationRouter({
    isDialogLive: () =>
      state.tag === "processing-followup" ||
      state.tag === "processing-interactive" ||
      state.tag === "executing-step",
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
      (state.tag === "processing-followup" ||
        state.tag === "processing-interactive" ||
        state.tag === "executing-step")
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
    if (entered && state.tag === "processing-followup") {
      // submit-followup just landed. The previous assistant turn is already
      // in the transcript; we push a follow-up user turn so the LLM sees
      // `[..., assistant, user]` — no message-history hygiene needed.
      const followupText = state.draft;
      transcript.push({ kind: "user", text: followupText });
      loopState.budgetRemaining = maxRounds;
      startPumpLoop();
    }
    if (entered && state.tag === "processing-interactive") {
      // submit-interactive just landed on an empty transcript. Run skills
      // first (silent, ≤1s/task), then seed [skill turns..., user turn].
      // Framing is applied per-call by `requestFraming`. The chrome spinner
      // is suppressed automatically because startPumpLoop reads
      // isDialogTag(state.tag) — dialog is up.
      const draft = state.draft;
      entry.input_source = "tui";
      // --verbose buffers lines through the notification bus while the dialog
      // is up and flushes on teardown, so this prompt echo lands in scrollback
      // after the invocation finishes — users get to see exactly what they
      // submitted without the live dialog competing for attention.
      if (config.verbose) {
        for (const line of draft.split("\n")) verbose(`prompt: ${line}`);
      }
      void seedAndPumpInteractive(draft);
    }
    if (entered && state.tag === "editor-handoff") {
      void beginEditorHandoff(state.draft);
    }
    if (entered && state.tag === "executing-step") {
      // submit-step-confirm hook: the user just confirmed a non-final
      // med/high step (or finished editing one). Capture its output,
      // emit step-output through the bus, push a step turn, reset budget,
      // then re-enter pumpLoop for the next round.
      void runConfirmedStep(state.response, state.source);
    }
  };

  async function runConfirmedStep(
    response: import("../command-response.schema.ts").CommandResponse,
    source: "model" | "user_override",
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
        kind: "step",
        command: response.content,
        exit_code: exec.exitCode,
        output: stepOutput,
        shell: exec.shell,
        source,
        exec_ms: exec.exec_ms,
      });
      loopState.budgetRemaining = maxRounds;
      startPumpLoop();
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const err = e instanceof Error ? e : new Error(String(e));
      dispatch({ type: "loop-error", error: err });
    }
  }

  // Mirrors the argv path's `seedFirstUserTurn` call but lives inside the
  // dispatch hook so it can be abort-aware: a user Esc during the skill
  // run flips state back to `composing-interactive` and we bail rather
  // than push turns into a transcript the user has walked away from.
  async function seedAndPumpInteractive(draft: string): Promise<void> {
    const ctrl = new AbortController();
    currentLoopAbort = ctrl;
    try {
      await seedFirstUserTurn(options.skills, draft, transcript);
      if (ctrl.signal.aborted) return;
      loopState.budgetRemaining = maxRounds;
      startPumpLoop();
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const err = e instanceof Error ? e : new Error(String(e));
      dispatch({ type: "loop-error", error: err });
    }
  }

  // Terminal-owning editor handoff. GUI editors bypass this tag entirely
  // (dialog-local spawn). Here Ink has already unmounted because the
  // reducer tag is not in `isDialogTag`. We explicitly drop raw mode —
  // Ink's unmount doesn't always clear it, and a raw-mode TTY in the
  // editor child produces wedged input. Kitty disambiguate mode is
  // popped by the compose useEffect cleanup; we don't also pop it here.
  async function beginEditorHandoff(handoffDraft: string): Promise<void> {
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      const resolved = resolveEditor();
      if (!resolved) {
        dispatch({ type: "editor-done", text: null });
        return;
      }
      const newText = await spawnEditor(resolved, handoffDraft);
      dispatch({ type: "editor-done", text: newText });
    } catch {
      dispatch({ type: "editor-done", text: null });
    }
  }

  async function syncDialog(): Promise<void> {
    const wantsDialog = isDialogTag(state.tag);
    const mounted = router.isDialogMounted();

    if (wantsDialog && mountInProgress) return;

    const continuationPrompt = options.continuationParent?.parentPrompt;

    if (wantsDialog && !mounted) {
      mountInProgress = true;
      try {
        if (inkReady) await inkReady;
        router.setDialog(mountResponseDialog({ state, dispatch, continuationPrompt }));
      } finally {
        mountInProgress = false;
      }
      // State may have moved during the await (e.g. user Esc'd while we
      // were mounting). The recursive call is sync from here — host is set.
      void syncDialog();
      return;
    }

    if (wantsDialog && mounted) {
      router.getDialog()?.rerender({ state, dispatch, continuationPrompt });
      return;
    }

    if (!wantsDialog && mounted) {
      router.teardownDialog();
    }
  }

  function startPumpLoop(): void {
    const ctrl = new AbortController();
    currentLoopAbort = ctrl;
    // The chrome spinner and the dialog's bottom-border spinner report the
    // same thing; only one should run at a time or they flicker against each
    // other. If a dialog is mounted for the current state, the dialog owns
    // the spinner. `isDialogTag(state.tag)` is the single source of truth.
    const showSpinner = !isDialogTag(state.tag);
    // `thinking` is the only non-dialog tag that pumps the loop, so equality
    // with it is the initial-loop signal (post-followup/interactive states are
    // dialog tags and never produce the initial loop).
    const isInitialLoop = state.tag === "thinking";
    void pumpLoop({
      provider,
      transcript,
      scaffold,
      loopState,
      baseLoopOptions: makeBaseLoopOptions(),
      signal: ctrl.signal,
      isInitialLoop,
      showSpinner,
      dispatch,
    });
  }

  const unsubscribe = router.subscribe();

  let exitCode = 1;
  try {
    // Interactive bootstrap skips the initial pump — the user hasn't typed
    // a prompt yet. submit-interactive kicks off the loop via the post-
    // transition hook on entering `processing-interactive`.
    if (!isInteractiveBootstrap) {
      startPumpLoop();
    } else {
      // Mount the compose dialog immediately so the user can start typing.
      void syncDialog();
    }
    const outcome = await exitDeferred.promise;
    // Unmount before exec so the alt screen is gone when the inherited
    // stdio command writes. The listener stays subscribed so verbose/chrome
    // lines from the exec phase still route through the bus.
    router.teardownDialog();
    exitCode = await finaliseOutcome(outcome, entry);
  } finally {
    unsubscribe();
    router.teardownDialog();
    // Continuation storage rule: the child's entry persists ONLY its own
    // invocation's turns. The seeded ancestor chain lives on disk in the
    // parent entries already — re-storing it here is O(D²) and the replay
    // path doesn't need it. Slice off the leading ancestor turns before
    // serialization. See [[continuation]] § Replay model.
    if (options.continuationParent) {
      entry.turns = entry.turns.slice(options.continuationParent.assembledTurns.length);
    }
    appendLogEntryIgnoreErrors(entry);
  }

  return exitCode;
}

function appendLogEntryIgnoreErrors(entry: LogEntry): void {
  try {
    appendLogEntry(entry);
  } catch {
    // Logging must never break the tool.
  }
}

// Skill turns sit between the system/scaffold and the user prompt so the
// user's natural-language request is the last (and freshest) message —
// the trust-fence guard for false-positive trigger matches. Called from
// both entry points where a new user prompt enters the transcript: argv
// at session start, and `state.draft` on interactive submit.
async function seedFirstUserTurn(
  skills: readonly Skill[] | undefined,
  prompt: string,
  transcript: Transcript,
): Promise<void> {
  if (skills) {
    const skillTurns = await runSkills(skills, prompt);
    verbose(`Skill turns: ${skillTurns.length}`);
    if (skillTurns.length) transcript.push(...skillTurns);
  }
  transcript.push({ kind: "user", text: prompt });
}

type PumpLoopArgs = {
  provider: Provider;
  transcript: Transcript;
  scaffold: ReturnType<typeof assemblePromptScaffold>;
  loopState: LoopState;
  baseLoopOptions: Omit<LoopOptions, "signal" | "showSpinner">;
  signal: AbortSignal;
  isInitialLoop: boolean;
  /** Whether to show the chrome (bottom-of-screen) spinner for this pump.
   *  False whenever a dialog is mounted — the dialog's bottom-border
   *  spinner already reports progress and the two would flicker. */
  showSpinner: boolean;
  dispatch: (event: AppEvent) => void;
};

/**
 * Drain a `runLoop` generator and route its events back to the session via
 * `dispatch` (`loop-final` / `loop-error` / `block`).
 */
async function pumpLoop(args: PumpLoopArgs): Promise<void> {
  const { signal, isInitialLoop, showSpinner, dispatch } = args;

  function handleLoopEvent(event: LoopEvent): void {
    switch (event.type) {
      case "assistant-turn":
        // The turn is already pushed onto the transcript (= entry.turns).
        // Nothing additional to do here; the event exists for telemetry.
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
      showSpinner,
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
      dispatch({ type: "block", command: final.response.content, response: final.response });
      return;
    }
    dispatch({ type: "loop-final", result: final });
  } catch (e) {
    if (signal.aborted) return;
    const err = e instanceof Error ? e : new Error(String(e));
    dispatch({ type: "loop-error", error: err });
  }
}

/**
 * Pull the last LLM-proposed command bytes out of the transcript. Used by
 * `finaliseOutcome` to populate the `final` turn's `command` field for
 * outcomes that didn't have an explicit command (cancelled/exhausted/error).
 * Walks assistant turns only — `step.command` may carry user-override bytes
 * from a confirmed step, and the spec wants the model's last proposal here,
 * not what the user actually ran. Empty string if the LLM never proposed a
 * command.
 */
function lastProposedCommand(entry: LogEntry): string {
  for (let i = entry.turns.length - 1; i >= 0; i--) {
    const turn = entry.turns[i];
    if (turn?.kind === "assistant" && turn.response?.type === "command") {
      return turn.response.content;
    }
  }
  return "";
}

export async function finaliseOutcome(outcome: SessionOutcome, entry: LogEntry): Promise<number> {
  switch (outcome.kind) {
    case "answer":
      // Pure-answer sessions have no `final` turn per spec — the last
      // assistant turn carries the reply.
      console.log(outcome.content);
      entry.outcome = "success";
      return 0;
    case "exhausted": {
      const proposed = lastProposedCommand(entry);
      entry.turns.push({
        kind: "final",
        command: proposed,
        exit_code: null,
        source: "exhausted",
      });
      const roundsUsed = entry.turns.filter((t) => t.kind === "assistant").length;
      chrome(`Could not resolve the request within ${roundsUsed} rounds.`);
      entry.outcome = "max_rounds";
      return 1;
    }
    case "blocked":
      entry.turns.push({
        kind: "final",
        command: outcome.command,
        exit_code: null,
        source: "blocked",
      });
      entry.outcome = "blocked";
      return 1;
    case "cancel": {
      const command = outcome.response?.content ?? lastProposedCommand(entry);
      entry.turns.push({
        kind: "final",
        command,
        exit_code: null,
        source: "cancelled",
      });
      entry.outcome = "cancelled";
      return 0;
    }
    case "error":
      // Throw rather than return — main.ts catches and renders via chrome.
      // The throw runs AFTER the finally writes the log, so the failure
      // turn is on disk regardless of what main.ts does next.
      entry.turns.push({
        kind: "final",
        command: lastProposedCommand(entry),
        exit_code: null,
        source: "error",
      });
      entry.outcome = "error";
      throw new Error(outcome.message);
    case "run": {
      verbose(`Running: ${outcome.command}`);
      const exec = await executeShellCommand(outcome.command, { mode: "inherit" });
      entry.turns.push({
        kind: "final",
        command: outcome.command,
        exit_code: exec.exitCode,
        shell: exec.shell,
        source: outcome.source,
        exec_ms: exec.exec_ms,
      });
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
