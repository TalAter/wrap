import { addToWatchlist } from "../discovery/watchlist.ts";
import type { PromptScaffold } from "../llm/build-prompt.ts";
import type { Provider } from "../llm/types.ts";
import type { Round } from "../logging/entry.ts";
import { appendFacts } from "../memory/memory.ts";
import { chrome } from "./output.ts";
import { prettyPath, resolvePath } from "./paths.ts";
import { runRound } from "./round.ts";
import { executeShellCommand } from "./shell.ts";
import type { Transcript } from "./transcript.ts";
import { truncateMiddle } from "./truncate.ts";
import { verbose } from "./verbose.ts";

export type LoopState = {
  /** Remaining round budget. Decremented per iteration. Reset on follow-up by the coordinator. */
  budgetRemaining: number;
  /** Monotonic round counter. Never reset. */
  roundNum: number;
};

export type LoopOptions = {
  cwd: string;
  wrapHome: string;
  /** Display label for the active provider, e.g. "anthropic / claude-sonnet-4-6". */
  model: string;
  maxRounds: number;
  maxCapturedOutput: number;
  pipedInput?: string;
  signal?: AbortSignal;
  /**
   * Forwarded to `runRound` per iteration. The session sets this true for the
   * initial loop in `thinking`, false for follow-up loops in `processing`.
   */
  showSpinner: boolean;
};

export type LoopEvent =
  /**
   * Yielded immediately after a successful LLM round. The Round object is the
   * one the consumer should `addRound(entry, round)` — same reference, so any
   * later mutation by the consumer (exec_ms / execution after final exec)
   * lands in the entry too. The consumer is responsible for stamping
   * `round.followup_text` on the first round-complete of each loop restart;
   * the runner doesn't know about follow-ups.
   */
  | { type: "round-complete"; round: Round }
  /**
   * Yielded just before executing a non-final low-risk step. The consumer
   * surfaces this as a chrome line (or to the dialog's status slot if a
   * dialog is up). The runner does NOT call chrome() itself for this event.
   */
  | { type: "step-running"; explanation: string; icon: string }
  /**
   * Yielded after a step finishes, with the post-truncated output that was
   * pushed back to the LLM.
   */
  | { type: "step-output"; text: string };

export type LoopReturn =
  | {
      type: "command";
      response: import("../command-response.schema.ts").CommandResponse;
      round: Round;
    }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  /**
   * The generator's signal-check fired and it bailed out before a final
   * response. The consumer's `ctrl.signal.aborted` guard ALSO catches this
   * (belt and braces), but the variant is here so the contract is explicit.
   */
  | { type: "aborted" };

/** Pick 🌐 over 🔍 for URL-fetching steps. */
export function fetchesUrl(content: string): boolean {
  return /^\s*(curl|wget)\b[^\n]*https?:\/\//.test(content);
}

function handleMemoryUpdates(
  response: import("../command-response.schema.ts").CommandResponse,
  wrapHome: string,
  cwd: string,
): void {
  if (!response.memory_updates?.length) return;
  appendFacts(wrapHome, response.memory_updates, cwd);
  verbose(`Memory updated: ${response.memory_updates.length} facts`);
  if (response.memory_updates_message) {
    const scopes = response.memory_updates
      .map((u) => resolvePath(u.scope, cwd))
      .filter((s): s is string => s !== null && s !== "/");
    const deepest = scopes.sort((a, b) => b.length - a.length)[0];
    const text = deepest
      ? `(${prettyPath(deepest)}) ${response.memory_updates_message}`
      : response.memory_updates_message;
    chrome(text, "🧠");
  }
}

/**
 * Drive the round loop until a final-form response, exhaustion, or abort.
 *
 * Per iteration:
 *   1. Check options.signal — if aborted, return `{ type: "aborted" }`.
 *   2. Call runRound. Re-check options.signal IMMEDIATELY after the await.
 *      If aborted, return `{ type: "aborted" }` WITHOUT pushing to the
 *      transcript or yielding round-complete (orphan-turn prevention).
 *   3. yield round-complete with the produced Round.
 *   4. Apply side effects: memory updates, watchlist additions.
 *   5. Route by response shape:
 *        - reply                         → push answer turn, return { type: "answer" }
 *                                          (LoopReturn variant name stays "answer" — the schema
 *                                          field is decoupled from the coordinator-facing tag.)
 *        - command, final: true          → push candidate_command turn, return { type: "command" }
 *        - command, final: false, low    → execute inline, push step turn, continue
 *        - command, final: false, !low   → push candidate_command turn, return { type: "command" };
 *                                          the coordinator hands it to the confirmation dialog and
 *                                          re-enters pumpLoop via the submit-step-confirm hook.
 *   6. When budget reaches zero, return { type: "exhausted" }.
 *
 * Error propagation: `runRound` throws a typed `RoundError` carrying the
 * partial Round. We catch it, yield `round-complete` with the partial
 * round (so the consumer logs it), then re-throw.
 */
export async function* runLoop(
  provider: Provider,
  transcript: Transcript,
  scaffold: PromptScaffold,
  state: LoopState,
  options: LoopOptions,
): AsyncGenerator<LoopEvent, LoopReturn> {
  while (state.budgetRemaining > 0) {
    if (options.signal?.aborted) return { type: "aborted" };

    state.roundNum += 1;
    state.budgetRemaining -= 1;
    // budgetRemaining === 0 (post-decrement) means this is the last round of
    // the current call. After a follow-up resets budgetRemaining to maxRounds,
    // this becomes true again — which is correct, unlike checking roundNum
    // against maxRounds (which would be wrong across follow-ups).
    const isLastRound = state.budgetRemaining === 0;

    if (state.roundNum > 1) {
      verbose(`Round ${state.roundNum}/${options.maxRounds}`);
    }
    if (isLastRound) {
      verbose("Final round: must return command or answer");
    }
    verbose(`Calling ${options.model}...`);

    let round: Round;
    try {
      round = await runRound(provider, transcript, scaffold, {
        isLastRound,
        model: options.model,
        showSpinner: options.showSpinner,
      });
    } catch (e) {
      // RoundError carries the partial round so the consumer can log it
      // before the throw propagates.
      const partial =
        e !== null && typeof e === "object" && "round" in e ? (e as { round: Round }).round : null;
      if (partial) yield { type: "round-complete", round: partial };
      throw e;
    }

    // Orphan-turn prevention: if the signal fired while we were awaiting the
    // LLM call, drop the result without pushing to the transcript or yielding
    // round-complete. The consumer's signal-check guard also catches this,
    // but the runner closes the race so a slow provider can't leave a stale
    // turn in the shared transcript that the next pumpLoop would see.
    if (options.signal?.aborted) return { type: "aborted" };

    yield { type: "round-complete", round };

    const response = round.parsed;
    if (!response) {
      // runRound's contract guarantees parsed is set on success — defensive.
      throw new Error("runRound returned a round without parsed");
    }

    handleMemoryUpdates(response, options.wrapHome, options.cwd);

    if (response.watchlist_additions?.length) {
      addToWatchlist(options.wrapHome, response.watchlist_additions);
      verbose(`Watchlist: added ${response.watchlist_additions.join(", ")}`);
    }

    if (response.type === "reply") {
      transcript.push({ kind: "answer", response });
      return { type: "answer", content: response.content };
    }

    // response.type === "command"
    const isNonFinalLow = response.final === false && response.risk_level === "low";

    if (!isNonFinalLow) {
      // Final commands (any risk) AND non-final med/high commands exit the
      // generator so the coordinator can run the confirmation dialog. The
      // distinction between "run" and "confirm-then-continue" is the
      // coordinator's job — the runner just surfaces the response.
      transcript.push({ kind: "candidate_command", response });
      return { type: "command", response, round };
    }

    // Non-final low: execute inline as an intermediate step and loop.
    if (isLastRound) {
      // The last-round instruction forbids final: false; if the model
      // ignored us we stop here without running the step.
      return { type: "exhausted" };
    }

    const stepIcon = fetchesUrl(response.content) ? "🌐" : "🔍";
    yield {
      type: "step-running",
      explanation: response.explanation || response.content,
      icon: stepIcon,
    };
    verbose(`Step: ${response.content}`);

    const stdinBlob =
      response.pipe_stdin && options.pipedInput ? new Blob([options.pipedInput]) : undefined;
    const exec = await executeShellCommand(response.content, {
      mode: "capture",
      stdinBlob,
    });

    // Orphan-turn prevention: same idea as the post-runRound check. Without
    // this, an Esc during the step await would still push the step turn.
    if (options.signal?.aborted) return { type: "aborted" };

    round.exec_ms = exec.exec_ms;
    round.execution = {
      command: response.content,
      exit_code: exec.exitCode,
      shell: exec.shell,
    };
    verbose(`Step exited (${exec.exitCode})`);

    let stepOutput = exec.stdout;
    if (exec.stderr.trim()) {
      stepOutput += (stepOutput.trim() ? "\n" : "") + exec.stderr;
    }
    stepOutput = truncateMiddle(stepOutput, options.maxCapturedOutput);

    yield { type: "step-output", text: stepOutput };
    transcript.push({
      kind: "step",
      response,
      output: stepOutput,
      exitCode: exec.exitCode,
    });
  }

  return { type: "exhausted" };
}
