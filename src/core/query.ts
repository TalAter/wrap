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
import {
  type ConversationMessage,
  formatProvider,
  type PromptInput,
  type Provider,
  type ResolvedProvider,
} from "../llm/types.ts";
import { addRound, createLogEntry, type LogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendFacts } from "../memory/memory.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import type { FollowupHandler } from "./followup-types.ts";
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
  /** Display label for the active provider, e.g. "anthropic / claude-sonnet-4-6". */
  model: string;
  /** Max rounds total — used by the last-round instruction trigger. */
  maxRounds: number;
  maxProbeOutput: number;
  pipedInput?: string;
  signal?: AbortSignal;
  /**
   * User text that triggered this loop call, stamped on the FIRST round only
   * so the log can attribute follow-up sequences back to the user message
   * that started them. Set by `createFollowupHandler`; absent for the
   * top-level call from `runQuery` (which is attributed to `entry.prompt`).
   */
  followupText?: string;
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
  // Stamp follow-up text on the first round only — even if it's a probe and
  // the real command lands several rounds later. Held as a consume-once
  // local so the second iteration has nothing left to stamp.
  let pendingFollowupText = options.followupText;
  while (state.budgetRemaining > 0) {
    if (options.signal?.aborted) return { type: "aborted" };

    state.roundNum += 1;
    state.budgetRemaining -= 1;
    const round: Round = {};
    if (pendingFollowupText !== undefined) {
      round.followup_text = pendingFollowupText;
      pendingFollowupText = undefined;
    }
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

    verbose(`Calling ${options.model}...`);
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
      // Wrap with the attempted provider/model so the user sees what was
      // tried — bare SDK messages (e.g. Anthropic's `"model: gpt-4o-mini"`)
      // give no hint that it's the *provider* rejecting the model.
      throw new Error(`LLM error (${options.model}): ${errMsg}`);
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

    // Log the command round eagerly (matching probe/answer rounds). The
    // caller mutates `exec_ms`/`execution` on the live array entry after
    // running — `addRound` is just a push, so post-push mutation surfaces
    // in the final JSONL flush.
    addRound(entry, round);
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
 * Live command + its already-logged round, shared by reference between
 * runQuery and the follow-up closure. The closure mutates both on each
 * successful refinement so chained follow-ups and the final exec see the
 * latest state. The round is logged eagerly by `runRoundsUntilFinal`;
 * runQuery only mutates `exec_ms`/`execution` on it after exec.
 */
export type CurrentCommand = {
  response: CommandResponse;
  round: Round;
};

export type FollowupHandlerDeps = {
  provider: Provider;
  input: PromptInput;
  state: LoopState;
  entry: LogEntry;
  options: RoundsOptions;
  current: CurrentCommand;
};

/**
 * Build the follow-up handler the dialog calls on user submit. Re-enters
 * `runRoundsUntilFinal` with the dialog's AbortSignal and mutates `current`
 * on a successful command so chained follow-ups and the eventual exec see
 * the swapped state.
 */
export function createFollowupHandler(deps: FollowupHandlerDeps): FollowupHandler {
  const { provider, input, state, entry, options, current } = deps;
  return async (text, signal) => {
    stripStaleInstructions(input.messages);
    input.messages.push(
      { role: "assistant", content: JSON.stringify(current.response) },
      { role: "user", content: text },
    );
    state.budgetRemaining = options.maxRounds;

    const result = await runRoundsUntilFinal(provider, input, state, entry, {
      ...options,
      signal,
      followupText: text,
    });

    // Race: the user can press Esc *after* the loop finishes but *before*
    // this resolves. The dialog will drop the result via its signal-check
    // guard, so we must NOT mutate `current` (which would corrupt the
    // user's next action). The orphan round is already in entry.rounds via
    // eager logging — nothing else to do.
    if (signal.aborted) return { type: "aborted" };

    if (result.type === "command") {
      current.response = result.response;
      current.round = result.round;
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
    // loop bailed out before any LLM call. The dialog drops it.
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
    resolvedProvider: ResolvedProvider;
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
    provider: options.resolvedProvider,
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

    const model = formatProvider(options.resolvedProvider);
    const state: LoopState = { budgetRemaining: maxRounds, roundNum: 0 };
    const roundsOptions: RoundsOptions = {
      cwd: options.cwd,
      wrapHome,
      model,
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
    const current: CurrentCommand = { response: result.response, round: result.round };
    if (current.response.risk_level !== "low") {
      const { showDialog } = await import("../tui/render.ts");
      const onFollowup = createFollowupHandler({
        provider,
        input,
        state,
        entry,
        options: roundsOptions,
        current,
      });
      const decision = await showDialog({
        command: current.response.content,
        riskLevel: current.response.risk_level,
        onFollowup,
        explanation: current.response.explanation ?? undefined,
      });
      if (decision.type === "answer") {
        console.log(decision.content);
        entry.outcome = "success";
        return 0;
      }
      if (decision.type === "exhausted") {
        chrome(`Could not resolve the request within ${maxRounds} rounds.`);
        entry.outcome = "max_rounds";
        return 1;
      }
      if (decision.type === "error") {
        entry.outcome = "error";
        throw new Error(decision.message);
      }
      if (decision.type !== "run") {
        entry.outcome = decision.type === "blocked" ? "blocked" : "cancelled";
        return 1;
      }
      current.response.content = decision.command;
    }
    verbose("Executing command...");
    const stdinBlob =
      current.response.pipe_stdin && options.pipedInput
        ? new Blob([options.pipedInput])
        : undefined;
    const exec = await executeShellCommand(current.response.content, {
      mode: "inherit",
      stdinBlob,
    });
    // In-place mutation: the round is already in entry.rounds.
    current.round.exec_ms = exec.exec_ms;
    current.round.execution = {
      command: current.response.content,
      exit_code: exec.exitCode,
      shell: exec.shell,
    };
    verbose(`Command exited (${exec.exitCode})`);
    entry.outcome = exec.exitCode === 0 ? "success" : "error";
    return exec.exitCode;
  } finally {
    try {
      appendLogEntry(wrapHome, entry);
    } catch {
      // Logging must never break the tool
    }
  }
}
