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
import type { PromptInput, Provider, ProviderConfig } from "../llm/types.ts";
import { addRound, createLogEntry, type LogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendFacts } from "../memory/memory.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import { getWrapHome } from "./home.ts";
import { chrome } from "./output.ts";
import { prettyPath, resolvePath } from "./paths.ts";
import { executeShellCommand } from "./shell.ts";
import { SPINNER_TEXT, startChromeSpinner } from "./spinner.ts";
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
          {
            role: "user",
            content: `${promptConstants.probeRiskRefusedPrefix} ${promptConstants.probeRiskInstruction}`,
          },
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
    const result = await runRoundsUntilFinal(provider, input, state, entry, {
      cwd: options.cwd,
      wrapHome,
      maxRounds,
      maxProbeOutput,
      pipedInput: options.pipedInput,
    });

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
      // runQuery doesn't pass an AbortSignal yet, so this branch is unreachable
      // from this caller. Step 7+ will wire a signal in via the follow-up
      // closure and add proper UX (state-machine transition, not exit). Throw
      // here so that step can't inherit a silent exit-1 by accident.
      throw new Error("runRoundsUntilFinal returned 'aborted' but runQuery passed no signal");
    }

    // type === "command"
    const { response, round } = result;
    if (response.risk_level !== "low") {
      const { showDialog } = await import("../tui/render.ts");
      // Stub follow-up handler — step 8 will replace this with the real
      // closure that re-enters runRoundsUntilFinal. For now it returns
      // exhausted immediately so the dialog UI is exercisable end-to-end.
      const followupStub = async () => ({ type: "exhausted" as const });
      const decision = await showDialog({
        command: response.content,
        riskLevel: response.risk_level,
        onFollowup: followupStub,
        explanation: response.explanation ?? undefined,
      });
      if (decision.type === "answer") {
        console.log(decision.content);
        entry.outcome = "success";
        addRound(entry, round);
        return 0;
      }
      if (decision.type === "exhausted") {
        chrome(`Could not resolve the request within ${maxRounds} rounds.`);
        entry.outcome = "max_rounds";
        addRound(entry, round);
        return 1;
      }
      if (decision.type === "error") {
        addRound(entry, round);
        throw new Error(decision.message);
      }
      if (decision.type !== "run") {
        entry.outcome = decision.type === "blocked" ? "blocked" : "cancelled";
        addRound(entry, round);
        return 1;
      }
      response.content = decision.command;
    }
    verbose("Executing command...");
    const stdinBlob =
      response.pipe_stdin && options.pipedInput ? new Blob([options.pipedInput]) : undefined;
    const exec = await executeShellCommand(response.content, {
      mode: "inherit",
      stdinBlob,
    });
    round.exec_ms = exec.exec_ms;
    round.execution = {
      command: response.content,
      exit_code: exec.exitCode,
      shell: exec.shell,
    };
    verbose(`Command exited (${exec.exitCode})`);
    entry.outcome = exec.exitCode === 0 ? "success" : "error";
    addRound(entry, round);
    return exec.exitCode;
  } finally {
    try {
      appendLogEntry(wrapHome, entry);
    } catch {
      // Logging must never break the tool
    }
  }
}
