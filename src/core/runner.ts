import { type Conversation, LlmAbortError } from "wrap-core/llm";
import { truncateMiddle } from "wrap-core/text";
import { getConfig } from "../config/store.ts";
import type { Transcript } from "../llm/framing.ts";
import type { AssistantTurn, Turn } from "../logging/entry.ts";
import { appendFacts } from "../memory/memory.ts";
import { addToWatchlist } from "../watchlist.ts";
import { chrome } from "./output.ts";
import { prettyPath, resolvePath } from "./paths.ts";
import { runRound } from "./round.ts";
import { executeShellCommand } from "./shell.ts";
import { verbose } from "./verbose.ts";

export type LoopState = {
  /** Remaining round budget. Decremented per iteration. Reset on follow-up by the coordinator. */
  budgetRemaining: number;
  /** Monotonic round counter. Never reset. */
  roundNum: number;
};

export type LoopOptions = {
  cwd: string;
  /** Display label for the active provider, e.g. "anthropic / claude-sonnet-4-6". */
  model: string;
  signal?: AbortSignal;
  /**
   * Forwarded to `runRound` per iteration. The session sets this true for the
   * initial loop in `thinking`, false for follow-up loops in `processing`.
   */
  showSpinner: boolean;
};

export type LoopEvent =
  /**
   * Yielded immediately after a successful or failed LLM round. The
   * `AssistantTurn` is already on the transcript by the time this event
   * fires — the consumer just observes (e.g. for telemetry or step-output
   * routing). RoundError yields this once before the throw propagates so
   * the partial turn is recorded.
   */
  | { type: "assistant-turn"; turn: AssistantTurn }
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
  cwd: string,
): void {
  if (!response.memory_updates?.length) return;
  appendFacts(response.memory_updates, cwd);
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
 *   2. Call runRound (sends on the session's conversation). An
 *      `LlmAbortError` from the round returns `{ type: "aborted" }` — the
 *      aborted send sealed its conversation entry with no replayable
 *      message and the round produced no turn. Re-check options.signal
 *      after the await as well (belt and braces — it also closes the abort
 *      race around step execution below).
 *   3. Push the assistant turn onto the transcript (which IS entry.turns).
 *      Its echo already entered the conversation through the send (or the
 *      round's explicit settled add) — the runner records, never re-adds.
 *      Yield assistant-turn so the consumer can observe.
 *   4. Apply side effects: memory updates, watchlist additions.
 *   5. Route by response shape:
 *        - reply                         → return { type: "answer" }
 *        - command, final: true          → return { type: "command" }
 *        - command, final: false, low    → execute inline, push step turn, continue
 *        - command, final: false, !low   → return { type: "command" }; coordinator
 *                                          hands it to the confirmation dialog and
 *                                          re-enters pumpLoop via submit-step-confirm.
 *   6. When budget reaches zero, return { type: "exhausted" }.
 *
 * Error propagation: `runRound` throws a typed `RoundError` carrying the
 * partial assistant turn. We catch it, push the turn onto the transcript
 * and yield assistant-turn (so the consumer logs it), then re-throw.
 */
export async function* runLoop(
  chat: Conversation,
  appendTurn: (turn: Turn) => void,
  transcript: Transcript,
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

    const maxRounds = getConfig().maxRounds;
    if (state.roundNum > 1) {
      verbose(`Round ${state.roundNum}/${maxRounds}`);
    }
    if (isLastRound) {
      verbose("Final round: must return command or answer");
    }
    verbose(`Calling ${options.model}...`);

    let turn: AssistantTurn;
    try {
      turn = await runRound(chat, {
        isLastRound,
        model: options.model,
        showSpinner: options.showSpinner,
        signal: options.signal,
      });
    } catch (e) {
      // An aborted send leaves no turn at all — today's parity: the JSONL
      // record never shows the round the user walked away from.
      if (e instanceof LlmAbortError) return { type: "aborted" };
      // RoundError carries the partial assistant turn so we record it
      // before the throw propagates.
      const partial =
        e !== null && typeof e === "object" && "turn" in e
          ? (e as { turn: AssistantTurn }).turn
          : null;
      if (partial) {
        transcript.push(partial);
        yield { type: "assistant-turn", turn: partial };
      }
      throw e;
    }

    // Orphan-turn prevention, belt and braces: a mid-send abort already
    // rejects with LlmAbortError above (core races the signal), so this
    // check should never fire for the LLM await itself — it guards the
    // generator against any future await sneaking in before the push.
    if (options.signal?.aborted) return { type: "aborted" };

    transcript.push(turn);
    yield { type: "assistant-turn", turn };

    const response = turn.response;
    if (!response) {
      // runRound's contract guarantees a response on success — defensive.
      throw new Error("runRound returned an assistant turn without a response");
    }

    handleMemoryUpdates(response, options.cwd);

    if (response.watchlist_additions?.length) {
      addToWatchlist(response.watchlist_additions);
      verbose(`Watchlist: added ${response.watchlist_additions.join(", ")}`);
    }

    if (response.type === "reply") {
      return { type: "answer", content: response.content };
    }

    // response.type === "command"
    // Yolo broadens inline-step to any risk — the user opted out of the gate.
    const canInlineStep =
      response.final === false && (response.risk_level === "low" || getConfig().yolo);

    if (!canInlineStep) {
      // Final commands (any risk) AND non-final med/high commands exit the
      // generator so the coordinator can run the confirmation dialog.
      return { type: "command", response };
    }

    // Inline-step path: execute and loop.
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

    const exec = await executeShellCommand(response.content, { mode: "capture" });

    // Orphan-turn prevention: same idea as the post-runRound check. Without
    // this, an Esc during the step await would still push the step turn.
    if (options.signal?.aborted) return { type: "aborted" };

    verbose(`Step exited (${exec.exitCode})`);

    let stepOutput = exec.stdout;
    if (exec.stderr.trim()) {
      stepOutput += (stepOutput.trim() ? "\n" : "") + exec.stderr;
    }
    const maxCapturedOutput = getConfig().maxCapturedOutputChars;
    stepOutput = truncateMiddle(stepOutput, maxCapturedOutput);

    yield { type: "step-output", text: stepOutput };
    // Step turns land through the session's `appendTurn` gate — onto the
    // transcript AND (framed) the live conversation — so the next send
    // assembles them without any per-round re-projection.
    appendTurn({
      kind: "step",
      command: response.content,
      exit_code: exec.exitCode,
      output: stepOutput,
      shell: exec.shell,
      source: "model",
      exec_ms: exec.exec_ms,
    });
  }

  return { type: "exhausted" };
}
