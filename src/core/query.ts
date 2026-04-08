import { NoObjectGeneratedError } from "ai";
import type { CommandResponse } from "../command-response.schema.ts";
import {
  DEFAULT_MAX_PIPED_INPUT_CHARS,
  DEFAULT_MAX_PROBE_OUTPUT_CHARS,
  DEFAULT_MAX_ROUNDS,
} from "../config/config.ts";
import type { ToolProbeResult } from "../discovery/init-probes.ts";
import { addToWatchlist } from "../discovery/watchlist.ts";
import { assembleCommandPrompt } from "../llm/context.ts";
import { runCommandPrompt } from "../llm/index.ts";
import type { ConversationMessage, PromptInput, Provider, ProviderConfig } from "../llm/types.ts";
import { addRound, createLogEntry, type LogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendFacts } from "../memory/memory.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import type { FollowupHandler } from "../tui/dialog.tsx";
import { getWrapHome } from "./home.ts";
import { chrome } from "./output.ts";
import { prettyPath, resolvePath } from "./paths.ts";
import { executeShellCommand } from "./shell.ts";
import { SPINNER_TEXT, startChromeSpinner } from "./spinner.ts";
import { verbose, verboseHighlight } from "./verbose.ts";

/**
 * The exact text pushed when the loop refuses a non-low-risk probe. Held as
 * a single constant so the producer (probe-refusal branch in
 * `runRoundsUntilFinal`) and the consumer (`stripStaleInstructions`) can
 * never drift — any change to one would silently break the other.
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

// Pick 🌐 over 🔍 for URL-fetching probes.
export function fetchesUrl(content: string): boolean {
  return /^\s*(curl|wget)\b[^\n]*https?:\/\//.test(content);
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
    return await runCommandPrompt(provider, input);
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
    });
  }
}

function handleMemoryUpdates(response: CommandResponse, wrapHome: string, cwd: string): void {
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

function verboseResponse(response: CommandResponse): void {
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

export type LoopState = {
  /** Remaining round budget. Decremented per iteration. Reset by follow-up. */
  budgetRemaining: number;
  /** Monotonic round counter. Never reset, even across follow-ups. */
  roundNum: number;
};

export type LoopResult =
  | { type: "command"; response: CommandResponse; round: Round }
  | { type: "answer"; content: string }
  | { type: "exhausted" }
  | { type: "aborted" };

export type RoundsOptions = {
  cwd: string;
  wrapHome: string;
  /** Max rounds total — used by the last-round instruction trigger. */
  maxRounds: number;
  maxProbeOutput: number;
  pipedInput?: string;
  signal?: AbortSignal;
};

/**
 * Run rounds until we have a final-form response (command/answer), exhaust the
 * budget, or get aborted. Probes are executed inline and their output is
 * appended to `input.messages`. Probe and answer rounds are logged via
 * `addRound(entry, ...)` as they complete.
 *
 * Command rounds are NOT logged inside this function — the round object is
 * returned in the result so the caller can fill in execution data and call
 * `addRound` after running (or after the user cancels).
 *
 * Throws on LLM errors (network failures, parse errors, empty responses). The
 * errored round is `addRound`'d before throwing so the log captures the
 * failure. The caller's outer `try/finally` then persists the log.
 *
 * The function does NOT execute final commands, does NOT print answers, and
 * does NOT touch `entry.outcome`. The caller dispatches on the returned
 * variant and owns all of those.
 */
export async function runRoundsUntilFinal(
  provider: Provider,
  input: PromptInput,
  state: LoopState,
  entry: LogEntry,
  options: RoundsOptions,
): Promise<LoopResult> {
  while (state.budgetRemaining > 0) {
    if (options.signal?.aborted) return { type: "aborted" };

    state.roundNum += 1;
    state.budgetRemaining -= 1;
    const round: Round = {};
    // budgetRemaining === 0 (post-decrement) means this is the last round of
    // the current call. After a follow-up resets budgetRemaining to maxRounds,
    // this becomes true again — which is correct, unlike checking roundNum
    // against maxRounds (which would be wrong across follow-ups).
    const isLastRound = state.budgetRemaining === 0;

    if (state.roundNum > 1) {
      verbose(`Round ${state.roundNum}/${options.maxRounds}`);
    }

    // On last round, instruct LLM not to probe
    if (isLastRound) {
      verbose("Final round: must return command or answer");
      input.messages.push({
        role: "user",
        content: promptConstants.lastRoundInstruction,
      });
    }

    // TODO(provider-label): replace "LLM" with the actual model name once
    // Provider exposes a `label` field. See specs/todo.md → "Make Provider
    // self-describing with a label field".
    verbose("Calling LLM...");
    const llmStart = performance.now();
    let response: CommandResponse;
    const stopSpinner = startChromeSpinner(SPINNER_TEXT);
    try {
      response = await callWithRetry(provider, input);

      // Probes must be low risk — retry once (same treatment as malformed JSON)
      if (response.type === "probe" && response.risk_level !== "low") {
        response = await callWithRetry(provider, {
          system: input.system,
          messages: [
            ...input.messages,
            { role: "assistant" as const, content: JSON.stringify(response) },
            {
              role: "user" as const,
              content: promptConstants.probeRiskInstruction,
            },
          ],
        });
      }
    } catch (e) {
      // Stop the spinner before logging so the error line lands on a clean
      // row instead of being glued to the trailing spinner frame.
      stopSpinner();
      const errMsg = e instanceof Error ? e.message : String(e);
      verbose(`LLM error: ${errMsg}`);
      round.provider_error = errMsg;
      round.llm_ms = Math.round(performance.now() - llmStart);
      addRound(entry, round);
      throw e;
    } finally {
      stopSpinner();
    }
    round.llm_ms = Math.round(performance.now() - llmStart);
    round.parsed = response;

    verboseResponse(response);

    handleMemoryUpdates(response, options.wrapHome, options.cwd);

    if (response.watchlist_additions?.length) {
      addToWatchlist(options.wrapHome, response.watchlist_additions);
      verbose(`Watchlist: added ${response.watchlist_additions.join(", ")}`);
    }

    if (!response.content.trim()) {
      addRound(entry, round);
      throw new Error("LLM returned an empty response.");
    }

    if (response.type === "answer") {
      addRound(entry, round);
      return { type: "answer", content: response.content };
    }

    if (response.type === "probe") {
      // Safety: refuse non-low-risk probes even after retry
      if (response.risk_level !== "low") {
        input.messages.push(
          { role: "assistant", content: JSON.stringify(response) },
          { role: "user", content: REFUSED_PROBE_INSTRUCTION },
        );
        addRound(entry, round);
        continue;
      }

      if (isLastRound) {
        addRound(entry, round);
        break;
      }

      const probeIcon = fetchesUrl(response.content) ? "🌐" : "🔍";
      chrome(response.explanation || response.content, probeIcon);

      verbose(`Probe: ${response.content}`);
      const stdinBlob =
        response.pipe_stdin && options.pipedInput ? new Blob([options.pipedInput]) : undefined;
      const exec = await executeShellCommand(response.content, {
        mode: "capture",
        stdinBlob,
      });
      round.exec_ms = exec.exec_ms;
      round.execution = {
        command: response.content,
        exit_code: exec.exitCode,
        shell: exec.shell,
      };
      verbose(`Probe exited (${exec.exitCode})`);

      let probeOutput = exec.stdout;
      if (exec.stderr.trim()) {
        probeOutput += (probeOutput.trim() ? "\n" : "") + exec.stderr;
      }
      if (exec.exitCode !== 0) {
        probeOutput += `\nExit code: ${exec.exitCode}`;
      }
      if (probeOutput.length > options.maxProbeOutput) {
        const total = probeOutput.length;
        probeOutput =
          probeOutput.slice(0, options.maxProbeOutput) +
          `\n[…truncated, showing first ${options.maxProbeOutput} of ${total} chars]`;
      }

      input.messages.push(
        { role: "assistant", content: JSON.stringify(response) },
        {
          role: "user",
          content: `${promptConstants.sectionProbeOutput}\n${probeOutput.trim() || promptConstants.probeNoOutput}`,
        },
      );

      addRound(entry, round);
      continue;
    }

    // type === "command" — caller will mutate `round` (exec_ms/execution) and
    // call `addRound` after running. NOT logged here so a throw between this
    // point and exec doesn't leave a half-finished round in the log.
    return { type: "command", response, round };
  }

  return { type: "exhausted" };
}

/**
 * Drop leftover meta-instructions from a previous loop call (last-round
 * prompt or refused-probe re-instruction). These are pushed by
 * `runRoundsUntilFinal` to steer the LLM mid-call; once the call ends
 * they're stale and would mislead subsequent calls. Called before a
 * follow-up re-enters the loop with the same `input.messages`.
 *
 * The refused-probe instruction is pushed as an `[assistant probe JSON,
 * user refusal]` pair. Stripping only the user side would leave an orphan
 * assistant turn that some providers reject and most find confusing, so we
 * remove the preceding assistant message together with the refusal.
 */
export function stripStaleInstructions(messages: PromptInput["messages"]): void {
  const cleaned: ConversationMessage[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.content === promptConstants.lastRoundInstruction) {
      continue;
    }
    if (m.role === "user" && m.content === REFUSED_PROBE_INSTRUCTION) {
      // Drop the matching assistant probe echo we already pushed.
      const last = cleaned[cleaned.length - 1];
      if (last && last.role === "assistant") cleaned.pop();
      continue;
    }
    cleaned.push(m);
  }
  messages.length = 0;
  messages.push(...cleaned);
}

/**
 * Mutable container for the "current" command + round so the follow-up
 * closure can update them as the user iterates. The round is held alongside
 * the response so it can be logged exactly once: the closure logs it before
 * re-entering the loop, then nulls the field; on a successful command result
 * the new round takes its place. The caller (runQuery) logs whatever round
 * remains after exec/cancel.
 */
export type FollowupRefs = {
  response: CommandResponse;
  round: Round | null;
};

export type FollowupHandlerDeps = {
  provider: Provider;
  input: PromptInput;
  state: LoopState;
  entry: LogEntry;
  options: RoundsOptions;
  refs: FollowupRefs;
};

/**
 * Build the follow-up handler the dialog calls when the user submits text.
 * The handler:
 * 1. Logs the about-to-be-superseded round (if not already logged).
 * 2. Strips stale meta-instructions left over from the previous call.
 * 3. Pushes `[assistant: currentResponse JSON, user: follow-up text]`.
 * 4. Resets the round budget (round numbering keeps incrementing).
 * 5. Re-enters `runRoundsUntilFinal` with the dialog's AbortSignal.
 * 6. Translates the loop result into a `FollowupResult` for the dialog.
 *
 * On a successful `command` result, `refs.response` and `refs.round` are
 * updated so chained follow-ups see the latest state and the caller can
 * exec the swapped command.
 */
export function createFollowupHandler(deps: FollowupHandlerDeps): FollowupHandler {
  const { provider, input, state, entry, options, refs } = deps;
  return async (text, signal) => {
    if (refs.round) {
      addRound(entry, refs.round);
      refs.round = null;
    }
    stripStaleInstructions(input.messages);
    input.messages.push(
      { role: "assistant", content: JSON.stringify(refs.response) },
      { role: "user", content: text },
    );
    state.budgetRemaining = options.maxRounds;

    const result = await runRoundsUntilFinal(provider, input, state, entry, {
      ...options,
      signal,
    });

    // Race: the user can press Esc *after* the loop finishes but *before*
    // this resolves. The dialog drops the result via its signal-check guard,
    // so we must NOT mutate refs (which would corrupt the displayed/logged
    // command for the user's next action). Log any orphaned command round
    // for the audit trail since the LLM did real work, then return aborted.
    if (signal.aborted) {
      if (result.type === "command") addRound(entry, result.round);
      return { type: "aborted" };
    }

    if (result.type === "command") {
      refs.response = result.response;
      refs.round = result.round;
      return {
        type: "command",
        command: result.response.content,
        riskLevel: result.response.risk_level,
        explanation: result.response.explanation ?? undefined,
      };
    }
    if (result.type === "answer") {
      return { type: "answer", content: result.content };
    }
    if (result.type === "exhausted") {
      return { type: "exhausted" };
    }
    // result.type === "aborted" — signal was aborted (handled above) or the
    // loop bailed out before any LLM call. Either way: return the typed
    // variant so the union stays exhaustive; the dialog drops it.
    return { type: "aborted" };
  };
}

/** Returns the process exit code. Caller is responsible for process.exit(). */
export async function runQuery(
  prompt: string,
  provider: Provider,
  options: {
    memory?: Memory;
    cwd: string;
    providerConfig: ProviderConfig;
    tools?: ToolProbeResult | null;
    cwdFiles?: string;
    pipedInput?: string;
    maxRounds?: number;
    maxProbeOutputChars?: number;
    maxPipedInputChars?: number;
  },
): Promise<number> {
  const wrapHome = getWrapHome();
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxProbeOutput = options.maxProbeOutputChars ?? DEFAULT_MAX_PROBE_OUTPUT_CHARS;
  const maxPipedInput = options.maxPipedInputChars ?? DEFAULT_MAX_PIPED_INPUT_CHARS;
  const memory = options.memory ?? {};
  const entry = createLogEntry({
    prompt,
    cwd: options.cwd,
    pipedInput: options.pipedInput,
    memory,
    provider: options.providerConfig,
    promptHash: PROMPT_HASH,
  });

  try {
    const input = assembleCommandPrompt(
      {
        prompt,
        cwd: options.cwd,
        memory,
        tools: options.tools,
        cwdFiles: options.cwdFiles,
        pipedInput: options.pipedInput,
        piped: !process.stdout.isTTY,
      },
      maxPipedInput,
    );

    const state: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
    const roundsOptions: RoundsOptions = {
      cwd: options.cwd,
      wrapHome,
      maxRounds,
      maxProbeOutput,
      pipedInput: options.pipedInput,
    };
    const result = await runRoundsUntilFinal(provider, input, state, entry, roundsOptions);

    if (result.type === "answer") {
      console.log(result.content);
      entry.outcome = "success";
      return 0;
    }

    if (result.type === "exhausted") {
      chrome(`Could not resolve the request within ${maxRounds} rounds.`);
      entry.outcome = "max_rounds";
      return 1;
    }

    if (result.type === "aborted") {
      // The outer call passes no AbortSignal; aborted is only produced via
      // the follow-up closure (which has its own dialog-driven signal). This
      // branch is unreachable but throws as a defensive marker so a future
      // caller that wires a top-level signal can't silently inherit exit 1.
      throw new Error("runRoundsUntilFinal returned 'aborted' but runQuery passed no signal");
    }

    // type === "command".
    // `refs.round` is the unlogged command round; it stays unlogged until we
    // decide what to do with it: exec it, cancel it, or let the follow-up
    // closure log it as a superseded round before swapping in a new one.
    const refs: FollowupRefs = { response: result.response, round: result.round };
    if (refs.response.risk_level !== "low") {
      const { showDialog } = await import("../tui/render.ts");
      const onFollowup = createFollowupHandler({
        provider,
        input,
        state,
        entry,
        options: roundsOptions,
        refs,
      });
      const decision = await showDialog({
        command: refs.response.content,
        riskLevel: refs.response.risk_level,
        onFollowup,
        explanation: refs.response.explanation ?? undefined,
      });
      // After the dialog returns, refs may have been mutated by the closure:
      // - refs.response holds the latest LLM command (possibly swapped)
      // - refs.round is the unlogged round for that command, OR null if the
      //   follow-up resolved with answer/exhausted (the closure logged the
      //   superseded round and produced no new command round to log)
      if (decision.type === "answer") {
        console.log(decision.content);
        entry.outcome = "success";
        if (refs.round) addRound(entry, refs.round);
        return 0;
      }
      if (decision.type === "exhausted") {
        chrome(`Could not resolve the request within ${maxRounds} rounds.`);
        entry.outcome = "max_rounds";
        if (refs.round) addRound(entry, refs.round);
        return 1;
      }
      if (decision.type === "error") {
        entry.outcome = "error";
        if (refs.round) addRound(entry, refs.round);
        throw new Error(decision.message);
      }
      if (decision.type !== "run") {
        entry.outcome = decision.type === "blocked" ? "blocked" : "cancelled";
        if (refs.round) addRound(entry, refs.round);
        return 1;
      }
      refs.response.content = decision.command;
    }
    // The unlogged command round always exists at this point: low-risk path
    // skips the dialog entirely (refs.round still set from the loop result),
    // and the dialog `run` path mutates refs.response.content above without
    // touching refs.round. The follow-up closure only nulls refs.round when
    // it logs and replaces it, in which case refs.round is the new round.
    if (!refs.round) {
      throw new Error("internal: command round missing before exec");
    }
    const finalRound = refs.round;
    verbose("Executing command...");
    const stdinBlob =
      refs.response.pipe_stdin && options.pipedInput ? new Blob([options.pipedInput]) : undefined;
    const exec = await executeShellCommand(refs.response.content, {
      mode: "inherit",
      stdinBlob,
    });
    finalRound.exec_ms = exec.exec_ms;
    finalRound.execution = {
      command: refs.response.content,
      exit_code: exec.exitCode,
      shell: exec.shell,
    };
    verbose(`Command exited (${exec.exitCode})`);
    entry.outcome = exec.exitCode === 0 ? "success" : "error";
    addRound(entry, finalRound);
    return exec.exitCode;
  } finally {
    try {
      appendLogEntry(wrapHome, entry);
    } catch {
      // Logging must never break the tool
    }
  }
}
