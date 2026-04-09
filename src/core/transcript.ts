import type { CommandResponse } from "../command-response.schema.ts";
import type { PromptScaffold } from "../llm/build-prompt.ts";
import type { ConversationMessage, PromptInput } from "../llm/types.ts";
import promptConstants from "../prompt.constants.json";

/**
 * The conversation between the user and the LLM, recorded as semantic turns
 * rather than as a provider-shaped `PromptInput`. This is the durable state
 * that the session, the runner, and the coordinator all read and write.
 *
 * Why semantic turns instead of `input.messages`:
 *   - Meta-instructions (`lastRoundInstruction`, refused-probe pairs) never
 *     enter the persistent state — they live only in the local scope of one
 *     `runRound` call, applied during `buildPromptInput` and discarded.
 *   - The transcript is the natural place to add new turn kinds for
 *     multi-step. The transcript IS the projection.
 */
export type Transcript = TranscriptTurn[];

export type TranscriptTurn =
  /**
   * A user turn — the initial query (first in the transcript) OR a follow-up
   * typed into the dialog. The two are not distinguished at the data layer
   * because they render identically. The "first turn is the initial query"
   * convention is positional.
   */
  | { kind: "user"; text: string }
  /**
   * A non-final command the loop executed inline. Carries the full LLM
   * response (so subsequent rounds can echo it as an assistant turn) plus
   * the captured output and exit code (rendered as a user turn).
   */
  | { kind: "probe"; response: CommandResponse; output: string; exitCode: number }
  /**
   * A final-form command the LLM proposed. Pushed by the loop just before
   * returning. Subsequent calls (e.g., after a follow-up) need it as an
   * assistant turn so the LLM sees its own previous answer.
   */
  | { kind: "candidate_command"; response: CommandResponse }
  /**
   * A final-form answer. Pushed by the loop just before returning. Rarely
   * needed in subsequent calls (answers usually exit the session) but
   * included for completeness.
   */
  | { kind: "answer"; response: CommandResponse };

/**
 * Ephemeral attempt-scoped directives that the builder applies for ONE call
 * only. Never persisted in the transcript.
 */
export type AttemptDirectives = {
  /** Append `lastRoundInstruction` as the final user turn. */
  isLastRound?: boolean;
  /**
   * For the in-round probe-risk retry: echo the rejected response as an
   * assistant turn and append `probeRiskInstruction` as the user turn so
   * the LLM can correct itself. Only used inside `runRound`'s retry block;
   * never in the persistent transcript.
   */
  probeRiskRetry?: { rejectedResponse: CommandResponse };
};

/**
 * Format a probe's captured output: prepend the section header, fall back to
 * the no-output sentinel when the post-processed body is blank, append a
 * trailing exit-code line on non-zero exits. The runner is responsible for
 * stdout+stderr merge and truncation BEFORE storing the probe turn —
 * `output` here is already post-processed; this function only adds the
 * surrounding section header / exit-code suffix / blank-output sentinel.
 */
function formatProbeBody(output: string, exitCode: number): string {
  let body = output;
  if (exitCode !== 0) {
    body += `\nExit code: ${exitCode}`;
  }
  const trimmed = body.trim();
  return `${promptConstants.sectionCapturedOutput}\n${trimmed.length > 0 ? trimmed : promptConstants.capturedNoOutput}`;
}

/**
 * Build a `PromptInput` (provider-shaped messages array) from a transcript
 * plus the session-static `PromptScaffold` plus optional ephemeral
 * directives. Pure function: does not mutate the transcript or the scaffold.
 *
 * The scaffold's `system` and `prefixMessages` are produced once at session
 * start and reused on every round; the directives are applied for ONE call
 * only. `scaffold.initialUserText` is unused here — the session pushes that
 * text into the transcript as the first `user` turn before any rounds run.
 */
export function buildPromptInput(
  transcript: Transcript,
  scaffold: PromptScaffold,
  directives?: AttemptDirectives,
): PromptInput {
  const messages: ConversationMessage[] = [];
  for (const m of scaffold.prefixMessages) messages.push(m);
  for (const turn of transcript) {
    switch (turn.kind) {
      case "user":
        messages.push({ role: "user", content: turn.text });
        break;
      case "probe":
        messages.push({
          role: "assistant",
          content: JSON.stringify(turn.response),
        });
        messages.push({
          role: "user",
          content: formatProbeBody(turn.output, turn.exitCode),
        });
        break;
      case "candidate_command":
      case "answer":
        messages.push({
          role: "assistant",
          content: JSON.stringify(turn.response),
        });
        break;
      default: {
        // Exhaustiveness — adding a new turn kind without handling it here
        // becomes a compile error.
        const _exhaustive: never = turn;
        throw new Error(`unhandled transcript turn: ${(_exhaustive as { kind: string }).kind}`);
      }
    }
  }
  if (directives?.probeRiskRetry) {
    messages.push({
      role: "assistant",
      content: JSON.stringify(directives.probeRiskRetry.rejectedResponse),
    });
    messages.push({
      role: "user",
      content: promptConstants.probeRiskInstruction,
    });
  }
  if (directives?.isLastRound) {
    messages.push({
      role: "user",
      content: promptConstants.lastRoundInstruction,
    });
  }
  return { system: scaffold.system, messages };
}
