import type { EchoPredicate, LlmMessage } from "wrap-core/llm";
import type { CommandResponse } from "../command-response.schema.ts";
import type { Turn } from "../logging/entry.ts";
import promptConstants from "../prompt.constants.json";

/**
 * The conversation between the user and the LLM as semantic turns. Same
 * array as the durable `LogEntry.turns[]` — one shape, two consumers (the
 * JSONL writer and the add-time framer). The session, runner, and round
 * all push directly onto it.
 *
 * Why semantic turns rather than conversation messages: turns are wrap's
 * own durable record (the session reads them mid-flight; `final` turns
 * never enter the live conversation), and each invocation applies its own
 * framing when turns become messages — storage stays bare.
 */
export type Transcript = Turn[];

/** Per-invocation framing for the first user turn. Storage is bare; each
 *  invocation (including a `-c` continuation) applies its own context. */
export type RequestFraming = { contextString: string; sectionUserRequest: string };

/**
 * Stateful turn → message framer bound to one conversation: the first user
 * turn it sees gets the invocation's request framing, everything after is
 * framed by turn kind alone. Probe turns expand to two messages; assistant
 * turns without a response frame to nothing.
 */
export type TurnFramer = {
  frame(turn: Turn): LlmMessage[];
};

/**
 * Format a step's captured output: prepend the section header, fall back to
 * the no-output sentinel when the post-processed body is blank, append a
 * trailing exit-code line on non-zero exits. The runner is responsible for
 * stdout+stderr merge and truncation BEFORE storing the step turn —
 * `output` here is already post-processed.
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
 * to the model on the next round. This is the one place that decides which
 * fields the LLM sees echoed back; every assistant-echo site (the
 * conversation's echo predicate, the explicit settled-echo add) must go
 * through this function, never the raw response.
 *
 * **Include:** `type`, `content`, `risk_level`, `final`, `plan` (when set).
 * **Strip:** `explanation` (user-facing, wastes tokens, invites misuse as a
 * scratchpad), `_scratchpad` (replaying stale plans encourages anchoring),
 * `memory_updates` / `memory_updates_message` / `watchlist_additions`
 * (already actioned by the runner).
 */
export function projectResponseForEcho(response: CommandResponse): Record<string, unknown> {
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
 * The canonical assistant-echo text: the projected response, serialized.
 * Every echo site (the conversation's echo predicate, the framer's assistant
 * case, the round's settled-echo add) builds its string here, so the
 * every-echo-goes-through-projection invariant is structural.
 */
export function echoText(response: CommandResponse): string {
  return JSON.stringify(projectResponseForEcho(response));
}

/** Domain rejection: a high-risk command must carry a scratchpad. */
export function isScratchpadRejected(response: CommandResponse): boolean {
  return (
    response.type === "command" && response.risk_level === "high" && response._scratchpad == null
  );
}

/**
 * Wrap's conversation-level echo predicate: a schema-valid response echoes
 * back as the projected JSON (`projectResponseForEcho`); a domain-rejected
 * response (high-risk command, null scratchpad) returns `null` so nothing
 * replayable lands — the round's settled echo is added explicitly by the
 * scratchpad retry flow in round.ts. Rejection flows through this
 * predicate, acceptance through an explicit add — the asymmetry is intended.
 */
export const formatCommandEcho: EchoPredicate = (parsed, _rawText) => {
  const response = parsed as CommandResponse;
  if (isScratchpadRejected(response)) return null;
  return echoText(response);
};

function probeAsEcho(command: string): Record<string, unknown> {
  return { type: "command", final: false, content: command, risk_level: "low" };
}

/**
 * Render a `final` Turn as a `<wrap-note>` body. Only meaningful on
 * continuation re-adds — within a single invocation, the final turn is
 * pushed at session end and never enters the conversation.
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
 * Create the per-invocation framer. One instance per conversation: the
 * first-user-turn framing is consumed exactly once across all `frame`
 * calls, so continuation re-adds, skill turns, and the fresh user prompt
 * share one rule no matter who frames them.
 */
export function createTurnFramer(framing?: RequestFraming): TurnFramer {
  let firstUserSeen = false;

  return {
    frame(turn: Turn): LlmMessage[] {
      switch (turn.kind) {
        case "user": {
          if (!firstUserSeen && framing) {
            firstUserSeen = true;
            const parts: string[] = [];
            if (framing.contextString) parts.push(framing.contextString);
            parts.push(`${framing.sectionUserRequest}\n${turn.text}`);
            return [{ role: "user", content: parts.join("\n\n") }];
          }
          firstUserSeen = true;
          return [{ role: "user", content: turn.text }];
        }
        case "assistant":
          // A fully-failed round (no parsed response) is preserved in the
          // log for forensic use but contributes nothing to the conversation.
          if (!turn.response) return [];
          return [{ role: "assistant", content: echoText(turn.response) }];
        case "step":
          return [{ role: "user", content: formatStepBody(turn.output, turn.exit_code) }];
        case "probe":
          return [
            { role: "assistant", content: JSON.stringify(probeAsEcho(turn.command)) },
            { role: "user", content: formatStepBody(turn.output, 0) },
          ];
        case "final":
          return [{ role: "user", content: wrapNote(formatFinalNote(turn)) }];
        default: {
          const _exhaustive: never = turn;
          throw new Error(`unhandled transcript turn: ${(_exhaustive as { kind: string }).kind}`);
        }
      }
    },
  };
}
