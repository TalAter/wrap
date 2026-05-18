import type { CommandResponse } from "../command-response.schema.ts";
import type { PromptScaffold } from "../llm/build-prompt.ts";
import type { ConversationMessage, PromptInput } from "../llm/types.ts";
import type { Turn } from "../logging/entry.ts";
import promptConstants from "../prompt.constants.json";

/**
 * The conversation between the user and the LLM. Same array as the durable
 * `LogEntry.turns[]` — one shape, two consumers (the JSONL writer and this
 * projector). The session, runner, and round.ts all push directly onto it.
 *
 * Why semantic turns rather than provider-shaped `input.messages`:
 *   - Meta-instructions (`lastRoundInstruction`, live temp-dir context, the
 *     first-user-turn framing) never enter the persistent state — they live
 *     only in the local scope of one `runRound` call, applied during
 *     `buildPromptInput` and discarded.
 *   - The transcript IS the projection target. Any new turn kind goes here.
 */
export type Transcript = Turn[];

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
   * Wraps the FIRST `user` turn encountered with `${contextString}\n\n${
   * sectionUserRequest}\n${text}`. Storage is bare; each invocation applies
   * its own framing. Continuation reuses the same directive with the
   * child's current context.
   */
  requestFraming?: { contextString: string; sectionUserRequest: string };
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
 * **Include:** `type`, `content`, `risk_level`, `final`, `plan` (when set).
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
  return out;
}

/**
 * Render a `final` Turn as a `<wrap-note>` body. Only meaningful inside a
 * continuation chain — within a single invocation, the final turn is the
 * last thing pushed and no projection happens after it.
 */
function formatFinalNote(turn: Extract<Turn, { kind: "final" }>): string {
  switch (turn.source) {
    case "model":
      return `previous command exited ${turn.exit_code}`;
    case "user_override":
      return `user ran the following instead of the proposal; exited ${turn.exit_code}:\n${turn.command}`;
    case "cancelled":
      return `user cancelled the previous command: ${turn.command}`;
    case "blocked":
      return "previous command was blocked";
    case "exhausted":
      return turn.command
        ? `previous run hit the round budget without completing or executing the proposed command; last proposal was: ${turn.command}`
        : "previous run hit the round budget without completing";
    case "error":
      return "previous run ended in an error before completing";
  }
}

function wrapNote(body: string): string {
  return `<wrap-note>\n${body}\n</wrap-note>`;
}

/**
 * Build a `PromptInput` (provider-shaped messages array) from a transcript
 * plus the session-static `PromptScaffold` plus optional ephemeral
 * directives. Pure function: does not mutate the transcript or the scaffold.
 *
 * The scaffold's `system` and `prefixMessages` are produced once at session
 * start and reused on every round; the directives are applied for ONE call
 * only.
 */
export function buildPromptInput(
  transcript: Transcript,
  scaffold: PromptScaffold,
  directives?: AttemptDirectives,
): PromptInput {
  const messages: ConversationMessage[] = [];
  for (const m of scaffold.prefixMessages) messages.push(m);
  let firstUserSeen = false;
  for (const turn of transcript) {
    switch (turn.kind) {
      case "user": {
        const framing = directives?.requestFraming;
        if (!firstUserSeen && framing) {
          firstUserSeen = true;
          const parts: string[] = [];
          if (framing.contextString) parts.push(framing.contextString);
          parts.push(`${framing.sectionUserRequest}\n${turn.text}`);
          messages.push({ role: "user", content: parts.join("\n\n") });
        } else {
          firstUserSeen = true;
          messages.push({ role: "user", content: turn.text });
        }
        break;
      }
      case "assistant":
        // A fully-failed round (no parsed response) is preserved in the log
        // for forensic use but contributes nothing to the replay conversation.
        if (!turn.response) break;
        messages.push({
          role: "assistant",
          content: JSON.stringify(projectResponseForEcho(turn.response)),
        });
        break;
      case "step":
        messages.push({
          role: "user",
          content: formatStepBody(turn.output, turn.exit_code),
        });
        break;
      case "final":
        messages.push({ role: "user", content: wrapNote(formatFinalNote(turn)) });
        break;
      case "cwd_change":
        messages.push({
          role: "user",
          content: wrapNote(`cwd changed from ${turn.from} to ${turn.to}`),
        });
        break;
      default: {
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
