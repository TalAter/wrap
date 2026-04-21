import { NoObjectGeneratedError } from "ai";
import type { CommandResponse } from "../command-response.schema.ts";
import { getConfig } from "../config/store.ts";
import { formatTempDirSection } from "../fs/temp.ts";
import type { PromptScaffold } from "../llm/build-prompt.ts";
import { runCommandPrompt } from "../llm/index.ts";
import type { PromptInput, Provider } from "../llm/types.ts";
import type { Attempt, Round, WireCapture } from "../logging/entry.ts";
import promptConstants from "../prompt.constants.json";
import { subscribe } from "./notify.ts";
import { StructuredOutputError } from "./parse-response.ts";
import { SPINNER_TEXT, startChromeSpinner } from "./spinner.ts";
import { type AttemptDirectives, buildPromptInput, type Transcript } from "./transcript.ts";
import { verbose, verboseHighlight } from "./verbose.ts";

export function isStructuredOutputError(e: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(e) ||
    (e instanceof Error &&
      (e.message.includes("invalid JSON") || e.message.includes("invalid response")))
  );
}

export function extractFailedText(e: unknown): string {
  if (NoObjectGeneratedError.isInstance(e)) return e.text ?? "";
  if (e instanceof StructuredOutputError) return e.text;
  return "";
}

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
};

/**
 * Typed error thrown by `runRound` on any failure that occurs after enough
 * of a round shape exists to be loggable. Carries the partial `Round` so
 * the loop can yield it via `round-complete` BEFORE re-throwing —
 * preserving the eager-log guarantee.
 */
export class RoundError extends Error {
  constructor(
    message: string,
    readonly round: Round,
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

/** Append an assistant+user turn pair suffixing a retry onto an input. */
function appendJsonRetry(input: PromptInput, failedText: string): PromptInput {
  return {
    system: input.system,
    messages: [
      ...input.messages,
      { role: "assistant", content: failedText },
      { role: "user", content: promptConstants.jsonRetryInstruction },
    ],
  };
}

/**
 * Execute a single physical LLM call, append an `Attempt` to `round.attempts`,
 * and return the parsed response OR `undefined` when a parse failure should
 * trigger the ladder's next retry step. Provider errors re-throw so the
 * coordinator can wrap them.
 */
async function callOne(
  provider: Provider,
  round: Round,
  input: PromptInput,
): Promise<CommandResponse | undefined> {
  const attempt: Attempt = {};
  round.attempts.push(attempt);

  const logTraces = getConfig().logTraces;

  let captured: WireCapture | undefined;
  const unsub = subscribe((n) => {
    if (n.kind === "llm-wire") captured = n.wire;
  });

  const t0 = performance.now();
  try {
    const response = (await runCommandPrompt(provider, input)) as CommandResponse;
    attempt.llm_ms = Math.round(performance.now() - t0);
    attempt.parsed = response;
    applyCapture(attempt, captured, logTraces, input);
    return response;
  } catch (e) {
    attempt.llm_ms = Math.round(performance.now() - t0);
    applyCapture(attempt, captured, logTraces, input);
    if (isStructuredOutputError(e)) {
      // Prefer the raw text from the error (what the model actually emitted).
      // The wire capture's raw_response may have been populated from a
      // successful emit before the SDK raised NoObjectGeneratedError.
      attempt.raw_response = extractFailedText(e);
      attempt.error = {
        kind: "parse",
        message: e instanceof Error ? e.message : String(e),
      };
      return undefined;
    }
    const msg = e instanceof Error ? e.message : String(e);
    attempt.error = { kind: "provider", message: msg };
    throw e;
  } finally {
    unsub();
  }
}

/**
 * Merge the captured wire bundle into the attempt, respecting the logTraces
 * gate. When `logTraces` is false: strip `request`, `request_wire`, and
 * `response_wire`. `raw_response` stays under its original rule — always on
 * parse failure (written by the caller after this), never on success.
 */
function applyCapture(
  attempt: Attempt,
  captured: WireCapture | undefined,
  logTraces: boolean,
  input: PromptInput,
): void {
  if (captured?.wire_capture_error !== undefined) {
    attempt.wire_capture_error = captured.wire_capture_error;
  }
  if (!logTraces) return;
  attempt.request = input;
  if (captured?.request_wire) attempt.request_wire = captured.request_wire;
  if (captured?.response_wire) attempt.response_wire = captured.response_wire;
  if (captured?.raw_response !== undefined) attempt.raw_response = captured.raw_response;
}

function sumAttemptMs(round: Round): number {
  let total = 0;
  for (const a of round.attempts) total += a.llm_ms ?? 0;
  return total;
}

/**
 * Run a single LLM round. Drives the retry ladder directly — up to four
 * physical calls per round, each appended as an `Attempt` before the ladder
 * decides whether to continue:
 *
 *   1. Initial call.
 *   2. If parse failed → json-retry (echo failed text + `jsonRetryInstruction`).
 *   3. If parsed a high-risk command with null scratchpad → scratchpad-retry.
 *   4. If 3 failed to parse → json-retry of the scratchpad attempt.
 *
 * Meta-directives (`isLastRound`, live temp-dir context) live only inside the
 * local `directives` arg to `buildPromptInput`; they never enter the
 * persistent transcript, so there is nothing to clean up after the call.
 *
 * On success: returns `Round` with `attempts[].at(-1).parsed` set and
 * `round.llm_ms` summed across attempts.
 *
 * On failure: throws `RoundError` carrying the partial `Round`. The loop
 * catches it, yields `round-complete` with the partial round (so it gets
 * logged), then re-throws.
 */
export async function runRound(
  provider: Provider,
  transcript: Transcript,
  scaffold: PromptScaffold,
  options: RunRoundOptions,
): Promise<Round> {
  const round: Round = { attempts: [] };
  const stopSpinner = options.showSpinner ? startChromeSpinner(SPINNER_TEXT) : () => {};
  try {
    const baseDirectives: AttemptDirectives = { liveContext: formatTempDirSection() };
    if (options.isLastRound) baseDirectives.isLastRound = true;

    const baseInput = buildPromptInput(transcript, scaffold, baseDirectives);

    // Step 1: initial call.
    let response = await callOne(provider, round, baseInput);

    // Step 2: json-retry on parse failure.
    if (response === undefined) {
      verbose("LLM parse error, retrying...");
      const failedText = round.attempts[round.attempts.length - 1]?.raw_response ?? "";
      response = await callOne(provider, round, appendJsonRetry(baseInput, failedText));
      if (response === undefined) {
        // Parse failed twice in a row — surface the last attempt's error.
        const last = round.attempts[round.attempts.length - 1];
        const msg = last?.error?.message ?? "LLM parse error";
        round.llm_ms = sumAttemptMs(round);
        throw new RoundError(`LLM error (${options.model}): ${msg}`, round);
      }
    }

    // Step 3: scratchpad-retry for high-risk + null scratchpad. Accept a
    // still-null scratchpad without storming the model; the confirm panel
    // remains the final safety layer.
    if (
      response.type === "command" &&
      response.risk_level === "high" &&
      response._scratchpad == null
    ) {
      const scratchDirectives: AttemptDirectives = {
        ...baseDirectives,
        scratchpadRequiredRetry: { rejectedResponse: response },
      };
      const scratchInput = buildPromptInput(transcript, scaffold, scratchDirectives);
      let scratchResponse = await callOne(provider, round, scratchInput);

      // Step 4: json-retry of the scratchpad attempt.
      if (scratchResponse === undefined) {
        verbose("LLM parse error, retrying...");
        const failedText = round.attempts[round.attempts.length - 1]?.raw_response ?? "";
        scratchResponse = await callOne(provider, round, appendJsonRetry(scratchInput, failedText));
      }

      if (scratchResponse !== undefined) response = scratchResponse;
      // If scratchpad path's parse-retry still failed, we keep the original
      // response; the round's last attempt carries the parse error for audit,
      // but `response` remains valid for execution. Same "don't retry-storm"
      // principle as accepting a still-null scratchpad.
    }

    verboseResponse(response);

    round.llm_ms = sumAttemptMs(round);

    if (!response.content.trim()) {
      const last = round.attempts[round.attempts.length - 1];
      if (last) {
        last.error = { kind: "empty", message: "LLM returned an empty response." };
      }
      throw new RoundError("LLM returned an empty response.", round);
    }

    return round;
  } catch (e) {
    if (e instanceof RoundError) throw e;
    // Provider-level error (non-structured). The failing attempt already
    // carries `error.kind: "provider"`; wrap with the model label so the
    // user sees which provider/model rejected.
    const errMsg = e instanceof Error ? e.message : String(e);
    verbose(`LLM error: ${errMsg}`);
    round.llm_ms = sumAttemptMs(round);
    throw new RoundError(`LLM error (${options.model}): ${errMsg}`, round);
  } finally {
    stopSpinner();
  }
}
