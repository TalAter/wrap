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
 *   - Meta-instructions (`lastRoundInstruction`, live temp-dir context) never
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
   * A non-final low-risk command the loop executed inline without user
   * confirmation. Carries the full LLM response (so subsequent rounds can
   * echo it as an assistant turn) plus the captured output and exit code
   * (rendered as a user turn).
   */
  | { kind: "step"; response: CommandResponse; output: string; exitCode: number }
  /**
   * A non-final medium/high-risk command the user confirmed via the dialog.
   * Shape identical to `step` and rendered the same way — the LLM does not
   * need to distinguish model-authored from user-confirmed steps. The round
   * audit log keeps the `source` distinction separately.
   */
  | { kind: "confirmed_step"; response: CommandResponse; output: string; exitCode: number }
  /**
   * A final-form command the LLM proposed. Pushed by the loop just before
   * returning. Subsequent calls (e.g., after a follow-up) need it as an
   * assistant turn so the LLM sees its own previous answer.
   */
  | { kind: "candidate_command"; response: CommandResponse }
  /**
   * A final-form reply. Pushed by the loop just before returning. Rarely
   * needed in subsequent calls (replies usually exit the session) but
   * included for completeness. The turn kind stays `answer` — it is
   * decoupled from the schema's `reply` discriminator.
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
   * A pre-formatted block of context that changes between rounds (e.g. the
   * current `$WRAP_TEMP_DIR` listing). Appended as a user turn after the
   * transcript but before `lastRoundInstruction`, so the LLM sees it with
   * every decision without polluting the persistent transcript.
   */
  liveContext?: string;
  /**
   * For the in-round high-risk scratchpad retry: echo the rejected response
   * (with its null `_scratchpad` preserved) as an assistant turn and append
   * `scratchpadRequiredInstruction` as the user turn so the LLM can fill
   * the missing field. Intra-round only.
   */
  scratchpadRequiredRetry?: { rejectedResponse: CommandResponse };
};

/**
 * Format a step's captured output: prepend the section header, fall back to
 * the no-output sentinel when the post-processed body is blank, append a
 * trailing exit-code line on non-zero exits. The runner is responsible for
 * stdout+stderr merge and truncation BEFORE storing the step turn —
 * `output` here is already post-processed; this function only adds the
 * surrounding section header / exit-code suffix / blank-output sentinel.
 */
function formatStepBody(output: string, exitCode: number): string {
  let body = output;
  if (exitCode !== 0) {
    body += `\nExit code: ${exitCode}`;
  }
  const trimmed = body.trim();
  return `${promptConstants.sectionCapturedOutput}\n${trimmed.length > 0 ? trimmed : promptConstants.capturedNoOutput}`;
}

/**
 * Project a `CommandResponse` down to the minimal shape that is meaningful
 * to the model on the next round. The builder is the one place that decides
 * which fields the LLM sees echoed back; every `JSON.stringify(response)` at
 * an assistant-turn site must go through this function, never the raw
 * response.
 *
 * **Include:** `type`, `content`, `risk_level`, `final`, `plan` (when set),
 * `pipe_stdin` (when set).
 * **Strip:** `explanation` (user-facing, wastes tokens, invites misuse as a
 * scratchpad), `memory_updates` / `memory_updates_message` / `watchlist_additions`
 * (already actioned by the runner).
 */
function projectResponseForEcho(response: CommandResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: response.type,
    final: response.final,
    content: response.content,
    risk_level: response.risk_level,
  };
  if (response.plan != null) out.plan = response.plan;
  if (response.pipe_stdin) out.pipe_stdin = response.pipe_stdin;
  return out;
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
      case "step":
      case "confirmed_step":
        messages.push({
          role: "assistant",
          content: JSON.stringify(projectResponseForEcho(turn.response)),
        });
        messages.push({
          role: "user",
          content: formatStepBody(turn.output, turn.exitCode),
        });
        break;
      case "candidate_command":
      case "answer":
        messages.push({
          role: "assistant",
          content: JSON.stringify(projectResponseForEcho(turn.response)),
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
  if (directives?.liveContext) {
    messages.push({ role: "user", content: directives.liveContext });
  }
  if (directives?.scratchpadRequiredRetry) {
    // Intentional raw stringify — the whole point is to show the model that
    // `_scratchpad` came back null so it knows what to fix.
    messages.push({
      role: "assistant",
      content: JSON.stringify(directives.scratchpadRequiredRetry.rejectedResponse),
    });
    messages.push({
      role: "user",
      content: promptConstants.scratchpadRequiredInstruction,
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
