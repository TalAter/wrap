import {
  type Attempt,
  type Conversation,
  type WireResponse as CoreWireResponse,
  type Entry,
  LlmAbortError,
  type LlmMessage,
  LlmParseError,
} from "wrap-core/llm";
import { type CommandResponse, CommandResponseSchema } from "../command-response.schema.ts";
import { getConfig } from "../config/store.ts";
import { formatTempDirSection } from "../fs/temp.ts";
import { echoText, isScratchpadRejected } from "../llm/framing.ts";
import type { AssistantTurn, AttemptMeta, WireResponse } from "../logging/entry.ts";
import promptConstants from "../prompt.constants.json";
import { SPINNER_TEXT, startChromeSpinner } from "./spinner.ts";
import { verbose, verboseHighlight } from "./verbose.ts";

export type RunRoundOptions = {
  isLastRound: boolean;
  /** Display label for the active provider, for the error message wrapper. */
  model: string;
  /**
   * Show the chrome spinner around the LLM call. The session passes `true`
   * for the initial loop in `thinking` (no dialog), `false` for follow-up
   * loops in `processing` (the dialog has its own bottom-border spinner).
   */
  showSpinner: boolean;
  /** Forwarded into each send. An abort rejects with `LlmAbortError`; the
   *  round leaves no turn (the runner maps it to its aborted return). */
  signal?: AbortSignal;
};

/**
 * Typed error thrown by `runRound` on any failure that occurs after enough
 * of an assistant turn shape exists to be loggable. Carries the partial
 * `AssistantTurn` so the loop can push it to the transcript BEFORE
 * re-throwing — preserving the eager-log guarantee.
 */
export class RoundError extends Error {
  constructor(
    message: string,
    readonly turn: AssistantTurn,
  ) {
    super(message);
    this.name = "RoundError";
  }
}

function verboseResponse(response: CommandResponse): void {
  if (response._scratchpad) {
    verboseHighlight("LLM scratchpad: ", response._scratchpad.replace(/\n/g, " \\n "));
  }
  switch (response.type) {
    case "command": {
      const tag = response.final ? "command" : "step";
      verboseHighlight(`LLM responded (${tag}, ${response.risk_level}): `, response.content);
      return;
    }
    case "reply":
      verbose(`LLM responded (reply, ${response.content.length} chars)`);
      return;
  }
}

/**
 * Add this round's per-call directives as ordered transient adds: the live
 * temp-dir listing, then (on the scratchpad retry) the raw rejected JSON as
 * an assistant/user echo pair, then the last-round instruction. Transients
 * are consumed by the send they precede — the scratchpad retry re-adds
 * whatever still applies because a later send never resurrects them.
 */
function addRoundDirectives(
  chat: Conversation,
  directives: {
    liveContext: string;
    isLastRound: boolean;
    scratchpadRejected?: CommandResponse;
  },
): void {
  chat.add({ role: "user", content: directives.liveContext }, { transient: true });
  if (directives.scratchpadRejected) {
    // Intentional raw stringify — the whole point is to show the model that
    // `_scratchpad` came back null so it knows what to fix.
    chat.add(
      { role: "assistant", content: JSON.stringify(directives.scratchpadRejected) },
      { transient: true },
    );
    chat.add(
      { role: "user", content: promptConstants.scratchpadRequiredInstruction },
      { transient: true },
    );
  }
  if (directives.isLastRound) {
    chat.add({ role: "user", content: promptConstants.lastRoundInstruction }, { transient: true });
  }
}

/** The round's settled assistant echo, added explicitly when the predicate
 *  rejected the response but wrap accepted it anyway (no-retry-storm rule)
 *  or kept it after a failed scratchpad retry. */
function addSettledEcho(chat: Conversation, response: CommandResponse): void {
  chat.add({ role: "assistant", content: echoText(response) });
}

/** Core subprocess wires carry `exitCode`; wrap's on-disk schema says `exit_code`. */
function toWrapResponseWire(wire: CoreWireResponse): WireResponse {
  if (wire.kind === "subprocess") {
    const { exitCode, ...rest } = wire;
    return { ...rest, exit_code: exitCode };
  }
  return wire;
}

/**
 * Map one core `Attempt` to wrap's on-disk `AttemptMeta`.
 *
 * - `parsed` lands on the (single) error-free attempt of a send — `parsed`
 *   lives on the sealed entry, and only the attempt that produced it lacks
 *   an error.
 * - `raw_response` keeps its rule: always on parse failure (the
 *   default-config debugging breadcrumb), otherwise only under `logTraces`.
 * - `request`/wires are trace-gated here, at wrap's record-build time —
 *   trace-verbosity gating is wrap policy, not core's.
 * - wrap's `empty` error kind is a post-parse domain annotation added by
 *   the caller, never derived from core.
 */
function toAttemptMeta(attempt: Attempt, parsed: unknown, logTraces: boolean): AttemptMeta {
  const meta: AttemptMeta = {};
  if (attempt.error === undefined && parsed !== undefined) {
    meta.parsed = parsed as CommandResponse;
  }
  if (logTraces) {
    meta.request = {
      system: attempt.request.system,
      messages: [...attempt.request.messages] as LlmMessage[],
    };
    if (attempt.requestWire) meta.request_wire = attempt.requestWire;
    if (attempt.responseWire) meta.response_wire = toWrapResponseWire(attempt.responseWire);
    if (attempt.rawText !== undefined) meta.raw_response = attempt.rawText;
  }
  if (attempt.error) {
    meta.error = { kind: attempt.error.kind, message: attempt.error.message };
    if (attempt.error.kind === "parse" && attempt.rawText !== undefined) {
      meta.raw_response = attempt.rawText;
    }
  }
  meta.llm_ms = attempt.durationMs;
  return meta;
}

/** Flatten the round's send-produced entries into one attempts list. */
function deriveAttempts(
  entries: readonly Entry[],
  logTraces: boolean,
): { attempts: AttemptMeta[]; totalMs: number } {
  const attempts: AttemptMeta[] = [];
  let totalMs = 0;
  for (const entry of entries) {
    if (!entry.attempts) continue;
    for (const attempt of entry.attempts) {
      attempts.push(toAttemptMeta(attempt, entry.parsed, logTraces));
      totalMs += attempt.durationMs;
    }
  }
  return { attempts, totalMs };
}

/**
 * Run a single LLM round on the session's conversation: up to two sends,
 * each with core's invisible parse retry inside it (so up to four physical
 * calls per round, all merged into ONE assistant turn for the log).
 *
 *   1. Add the round's transient directives (live temp-dir context,
 *      last-round instruction) and send.
 *   2. Domain retry — scratchpad: a schema-valid high-risk command with a
 *      null scratchpad was echo-rejected by the predicate (nothing
 *      replayable landed). Re-add the transients plus the raw rejected JSON
 *      as a transient assistant/user echo pair, and send again.
 *   3. If the second response carries a scratchpad its echo lands via the
 *      predicate; if it is still null (accepted anyway — no-retry-storm) or
 *      the second send fails to parse (wrap keeps response #1 for
 *      execution), the settled echo is added explicitly.
 *
 * On success: returns an `AssistantTurn` with `response` set, attempts
 * derived from the conversation record, and `llm_ms` summed across them.
 *
 * On failure: throws `RoundError` carrying the partial `AssistantTurn`
 * (derived from the sealed entries, so the eager-log guarantee holds), or
 * rethrows `LlmAbortError` untouched — an aborted round leaves no turn.
 */
export async function runRound(
  chat: Conversation,
  options: RunRoundOptions,
): Promise<AssistantTurn> {
  const turn: AssistantTurn = { kind: "assistant", attempts: [], source: "model" };
  const stopSpinner = options.showSpinner ? startChromeSpinner(SPINNER_TEXT) : () => {};
  const logTraces = getConfig().logTraces;
  const startIdx = chat.entries.length;

  const collect = (): void => {
    const { attempts, totalMs } = deriveAttempts(chat.entries.slice(startIdx), logTraces);
    turn.attempts = attempts;
    turn.llm_ms = totalMs;
  };
  const fail = (e: unknown): RoundError => {
    const message = e instanceof Error ? e.message : String(e);
    verbose(`LLM error: ${message}`);
    collect();
    return new RoundError(`LLM error (${options.model}): ${message}`, turn);
  };

  try {
    // Abort before any transient is added: a send on an already-fired signal
    // never starts and never consumes, which would leave these adds waiting
    // to leak into the NEXT round's assembly.
    if (options.signal?.aborted) throw new LlmAbortError();
    const liveContext = formatTempDirSection();
    addRoundDirectives(chat, { liveContext, isLastRound: options.isLastRound });

    let response: CommandResponse;
    try {
      response = await chat.send(CommandResponseSchema, { signal: options.signal });
    } catch (e) {
      if (e instanceof LlmAbortError) throw e;
      throw fail(e);
    }

    // Domain retry: high-risk + null scratchpad. Accept a still-null
    // scratchpad on the second send without storming the model; the confirm
    // panel remains the final safety layer.
    if (isScratchpadRejected(response)) {
      if (options.signal?.aborted) throw new LlmAbortError();
      addRoundDirectives(chat, {
        liveContext,
        isLastRound: options.isLastRound,
        scratchpadRejected: response,
      });
      try {
        const second = await chat.send(CommandResponseSchema, { signal: options.signal });
        if (isScratchpadRejected(second)) addSettledEcho(chat, second);
        response = second;
      } catch (e) {
        if (e instanceof LlmAbortError) throw e;
        if (!(e instanceof LlmParseError)) {
          // Provider failure mid-retry fails the round; the partial turn
          // still records the valid first response for the log.
          turn.response = response;
          throw fail(e);
        }
        // Scratchpad retry failed to parse — keep response #1 for execution
        // (its echo was predicate-rejected, so settle it explicitly). The
        // failed attempts stay on the round for audit.
        addSettledEcho(chat, response);
      }
    }

    verboseResponse(response);
    collect();
    turn.response = response;

    if (!response.content.trim()) {
      const last = turn.attempts.at(-1);
      if (last) {
        last.error = { kind: "empty", message: "LLM returned an empty response." };
      }
      throw new RoundError("LLM returned an empty response.", turn);
    }

    return turn;
  } finally {
    stopSpinner();
  }
}
