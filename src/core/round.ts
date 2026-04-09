import { NoObjectGeneratedError } from "ai";
import type { CommandResponse } from "../command-response.schema.ts";
import type { PromptScaffold } from "../llm/build-prompt.ts";
import { runCommandPrompt } from "../llm/index.ts";
import type { PromptInput, Provider } from "../llm/types.ts";
import type { Round } from "../logging/entry.ts";
import promptConstants from "../prompt.constants.json";
import { SPINNER_TEXT, startChromeSpinner } from "./spinner.ts";
import { type AttemptDirectives, buildPromptInput, type Transcript } from "./transcript.ts";
import { verbose, verboseHighlight } from "./verbose.ts";

/**
 * The exact text pushed when the loop refuses a non-low-risk probe. Held as
 * a single constant so the producer (probe-refusal branch in `runLoop`) and
 * any consumer can never drift. **TEMPORARY:** deleted entirely by
 * `specs/multi-step.md`, which removes the probe concept. Kept on the
 * post-refactor surface only because the refactor preserves the current
 * behaviour.
 */
export const REFUSED_PROBE_INSTRUCTION = `${promptConstants.probeRiskRefusedPrefix} ${promptConstants.probeRiskInstruction}`;

export function isStructuredOutputError(e: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(e) ||
    (e instanceof Error &&
      (e.message.includes("invalid JSON") || e.message.includes("invalid response")))
  );
}

export function extractFailedText(e: unknown): string {
  if (NoObjectGeneratedError.isInstance(e)) return e.text ?? "";
  return "";
}

/**
 * Call the LLM; on a structured-output parse failure, retry once with the
 * broken output appended so the model can self-correct.
 */
export async function callWithRetry(
  provider: Provider,
  input: PromptInput,
): Promise<CommandResponse> {
  try {
    return (await runCommandPrompt(provider, input)) as CommandResponse;
  } catch (e) {
    if (!isStructuredOutputError(e)) throw e;
    verbose("LLM parse error, retrying...");
    return runCommandPrompt(provider, {
      system: input.system,
      messages: [
        ...input.messages,
        { role: "assistant" as const, content: extractFailedText(e) },
        {
          role: "user" as const,
          content: promptConstants.jsonRetryInstruction,
        },
      ],
    }) as Promise<CommandResponse>;
  }
}

export type RunRoundOptions = {
  isLastRound: boolean;
  /** Display label for the active provider, for the error message wrapper. */
  model: string;
  /**
   * Show the chrome spinner around the LLM call. The session passes `true`
   * for the initial loop in `thinking` (no dialog), `false` for follow-up
   * loops in `processing` (the dialog has its own bottom-border spinner).
   * Spinner lifecycle is per LLM call (per `runRound`), not per loop —
   * between iterations, the spinner is stopped, so chrome lines emitted by
   * the loop (memory updates, step explanations) land on a clean stderr row
   * instead of racing the spinner's `\r`-rewritten frame.
   */
  showSpinner: boolean;
};

/**
 * Typed error thrown by `runRound` on any failure that occurs after enough
 * of a round shape exists to be loggable. Carries the partial `Round` (with
 * `provider_error` populated, or `parsed` populated for the empty-response
 * case) so the loop can yield it via `round-complete` BEFORE re-throwing —
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
    case "command":
      verboseHighlight(`LLM responded (command, ${response.risk_level}): `, response.content);
      break;
    case "answer":
      verbose(`LLM responded (answer, ${response.content.length} chars)`);
      break;
    case "probe":
      verboseHighlight("LLM responded (probe): ", response.content);
      break;
  }
}

/**
 * Run a single LLM round. Handles in-round retries:
 *   - structured-output parse failures (retried once with the broken text
 *     echoed back so the model can self-correct)
 *   - probe risk-level violations (a probe with risk_level !== "low" is
 *     retried once with the existing probeRiskInstruction text)
 *
 * Reads the transcript via `buildPromptInput(transcript, scaffold, directives)`.
 * Does NOT mutate the transcript — that's the caller's job. Meta-directives
 * like `isLastRound` and the probe-risk retry pair live ONLY inside the
 * local `directives` arg passed to `buildPromptInput`; they never enter the
 * persistent transcript, so there is nothing to clean up after the call
 * returns.
 *
 * On success: returns a `Round` with `parsed` and `llm_ms` populated.
 *
 * On failure: throws a `RoundError` carrying the partial `Round`. The loop
 * catches it, yields `round-complete` with the partial round (so it gets
 * logged), then re-throws to the coordinator.
 */
export async function runRound(
  provider: Provider,
  transcript: Transcript,
  scaffold: PromptScaffold,
  options: RunRoundOptions,
): Promise<Round> {
  const round: Round = {};
  const llmStart = performance.now();
  const stopSpinner = options.showSpinner ? startChromeSpinner(SPINNER_TEXT) : () => {};
  let response: CommandResponse;
  try {
    const directives: AttemptDirectives | undefined = options.isLastRound
      ? { isLastRound: true }
      : undefined;
    response = await callWithRetry(provider, buildPromptInput(transcript, scaffold, directives));

    // Probes must be low risk — retry once (same treatment as malformed JSON).
    if (response.type === "probe" && response.risk_level !== "low") {
      response = await callWithRetry(
        provider,
        buildPromptInput(transcript, scaffold, {
          ...(directives ?? {}),
          probeRiskRetry: { rejectedResponse: response },
        }),
      );
    }

    // High-risk destructive commands must carry a scratchpad so the reasoning
    // is visible in logs and to anyone reviewing the confirm panel. Retry
    // once if the model skipped it. A still-null retry is accepted — don't
    // retry-storm; the confirm panel remains the final safety layer.
    if (
      response.type === "command" &&
      response.risk_level === "high" &&
      response._scratchpad == null
    ) {
      response = await callWithRetry(
        provider,
        buildPromptInput(transcript, scaffold, {
          ...(directives ?? {}),
          scratchpadRequiredRetry: { rejectedResponse: response },
        }),
      );
    }
  } catch (e) {
    // Stop the spinner before logging so the error line lands on a clean row
    // instead of being glued to the trailing spinner frame.
    stopSpinner();
    const errMsg = e instanceof Error ? e.message : String(e);
    verbose(`LLM error: ${errMsg}`);
    round.provider_error = errMsg;
    round.llm_ms = Math.round(performance.now() - llmStart);
    // Wrap with the attempted provider/model so the user sees what was tried —
    // bare SDK messages give no hint that it's the *provider* rejecting.
    throw new RoundError(`LLM error (${options.model}): ${errMsg}`, round);
  } finally {
    stopSpinner();
  }
  round.llm_ms = Math.round(performance.now() - llmStart);
  round.parsed = response;

  verboseResponse(response);

  if (!response.content.trim()) {
    throw new RoundError("LLM returned an empty response.", round);
  }

  return round;
}
