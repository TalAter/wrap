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
  type PromptInput,
  type Provider,
  type ProviderConfig,
  providerLabel,
} from "../llm/types.ts";
import { addRound, createLogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendFacts } from "../memory/memory.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import { getWrapHome } from "./home.ts";
import { chrome } from "./output.ts";
import { prettyPath, resolvePath } from "./paths.ts";
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
    const prefix = deepest ? `🧠 (${prettyPath(deepest)}) ` : "🧠 ";
    chrome(`${prefix}${response.memory_updates_message}`);
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

    const model = providerLabel(options.providerConfig);

    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      const round: Round = {};
      const isLastRound = roundNum === maxRounds;

      if (roundNum > 1) {
        verbose(`Round ${roundNum}/${maxRounds}`);
      }

      // On last round, instruct LLM not to probe
      if (isLastRound) {
        verbose("Final round: must return command or answer");
        input.messages.push({
          role: "user",
          content: promptConstants.lastRoundInstruction,
        });
      }

      verbose(`Calling ${model}...`);
      const llmStart = performance.now();
      let response: CommandResponse;
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
        const errMsg = e instanceof Error ? e.message : String(e);
        verbose(`LLM error: ${errMsg}`);
        round.provider_error = errMsg;
        round.llm_ms = Math.round(performance.now() - llmStart);
        addRound(entry, round);
        throw e;
      }
      round.llm_ms = Math.round(performance.now() - llmStart);
      round.parsed = response;

      verboseResponse(response);

      handleMemoryUpdates(response, wrapHome, options.cwd);

      if (response.watchlist_additions?.length) {
        addToWatchlist(wrapHome, response.watchlist_additions);
        verbose(`Watchlist: added ${response.watchlist_additions.join(", ")}`);
      }

      if (!response.content.trim()) {
        chrome("LLM returned an empty response.");
        entry.outcome = "error";
        addRound(entry, round);
        return 1;
      }

      if (response.type === "answer") {
        console.log(response.content);
        entry.outcome = "success";
        addRound(entry, round);
        return 0;
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

        chrome(`🔍 ${response.explanation || response.content}`);

        const shell = process.env.SHELL || "sh";
        verbose(`Probe: ${response.content}`);
        const execStart = performance.now();
        const stdinBlob =
          response.pipe_stdin && options.pipedInput ? new Blob([options.pipedInput]) : undefined;
        const proc = Bun.spawn([shell, "-c", response.content], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: stdinBlob,
        });
        const [probeExit, stdoutText, stderrText] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        round.exec_ms = Math.round(performance.now() - execStart);
        round.execution = { command: response.content, exit_code: probeExit, shell };
        verbose(`Probe exited (${probeExit})`);

        let probeOutput = stdoutText;
        if (stderrText.trim()) {
          probeOutput += (probeOutput.trim() ? "\n" : "") + stderrText;
        }
        if (probeExit !== 0) {
          probeOutput += `\nExit code: ${probeExit}`;
        }
        if (probeOutput.length > maxProbeOutput) {
          const total = probeOutput.length;
          probeOutput =
            probeOutput.slice(0, maxProbeOutput) +
            `\n[…truncated, showing first ${maxProbeOutput} of ${total} chars]`;
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

      // type === "command"
      if (response.risk_level !== "low") {
        chrome(`Command requires confirmation (not yet supported): ${response.content}`);
        entry.outcome = "refused";
        addRound(entry, round);
        return 1;
      }
      const shell = process.env.SHELL || "sh";
      verbose("Executing command...");
      const execStart = performance.now();
      const stdinBlob =
        response.pipe_stdin && options.pipedInput ? new Blob([options.pipedInput]) : undefined;
      const proc = Bun.spawn([shell, "-c", response.content], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: stdinBlob ?? "inherit",
      });
      const exitCode = await proc.exited;
      round.exec_ms = Math.round(performance.now() - execStart);
      round.execution = { command: response.content, exit_code: exitCode, shell };
      verbose(`Command exited (${exitCode})`);
      entry.outcome = exitCode === 0 ? "success" : "error";
      addRound(entry, round);
      return exitCode;
    }

    // All rounds exhausted
    chrome(`Could not resolve the request within ${maxRounds} rounds.`);
    entry.outcome = "max_rounds";
    return 1;
  } finally {
    try {
      appendLogEntry(wrapHome, entry);
    } catch {
      // Logging must never break the tool
    }
  }
}
