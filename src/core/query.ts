import { NoObjectGeneratedError } from "ai";
import type { CommandResponse } from "../command-response.schema.ts";
import { assembleCommandPrompt } from "../llm/context.ts";
import { runCommandPrompt } from "../llm/index.ts";
import type { PromptInput, Provider, ProviderConfig } from "../llm/types.ts";
import { addRound, createLogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendFacts } from "../memory/memory.ts";
import type { Memory } from "../memory/types.ts";
import { promptHash as PROMPT_HASH } from "../prompt.optimized.json";
import { getWrapHome } from "./home.ts";
import { chrome } from "./output.ts";
import { prettyPath, resolvePath } from "./paths.ts";

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
    return runCommandPrompt(provider, {
      system: input.system,
      messages: [
        ...input.messages,
        { role: "assistant" as const, content: extractFailedText(e) },
        {
          role: "user" as const,
          content:
            "Your response was not valid JSON. Respond ONLY with valid JSON matching the schema.",
        },
      ],
    });
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
    toolsOutput?: string;
    cwdFiles?: string;
  },
): Promise<number> {
  const wrapHome = getWrapHome();
  let memory = options.memory ?? {};
  const entry = createLogEntry({
    prompt,
    cwd: options.cwd,
    memory,
    provider: options.providerConfig,
    promptHash: PROMPT_HASH,
  });
  const round: Round = {};

  try {
    const input = assembleCommandPrompt({
      prompt,
      cwd: options.cwd,
      memory,
      toolsOutput: options.toolsOutput,
      cwdFiles: options.cwdFiles,
      piped: !process.stdout.isTTY,
    });

    const llmStart = performance.now();
    let response: CommandResponse;
    try {
      response = await callWithRetry(provider, input);
    } catch (e) {
      round.provider_error = e instanceof Error ? e.message : String(e);
      round.llm_ms = Math.round(performance.now() - llmStart);
      throw e;
    }
    round.llm_ms = Math.round(performance.now() - llmStart);
    round.parsed = response;

    if (response.memory_updates?.length) {
      memory = appendFacts(wrapHome, response.memory_updates, options.cwd);
      if (response.memory_updates_message) {
        const scopes = response.memory_updates
          .map((u) => resolvePath(u.scope, options.cwd))
          .filter((s): s is string => s !== null && s !== "/");
        const deepest = scopes.sort((a, b) => b.length - a.length)[0];
        const prefix = deepest ? `🧠 (${prettyPath(deepest)}) ` : "🧠 ";
        chrome(`${prefix}${response.memory_updates_message}`);
      }
    }

    if (!response.content.trim()) {
      chrome("LLM returned an empty response.");
      entry.outcome = "error";
      return 1;
    }

    if (response.type === "answer") {
      console.log(response.content);
      entry.outcome = "success";
      return 0;
    }

    if (response.type === "probe") {
      chrome("Probe commands are not yet supported.");
      entry.outcome = "refused";
      return 1;
    }

    // type === "command"
    if (response.risk_level !== "low") {
      chrome(`Command requires confirmation (not yet supported): ${response.content}`);
      entry.outcome = "refused";
      return 1;
    }
    const shell = process.env.SHELL || "sh";
    const execStart = performance.now();
    const proc = Bun.spawn([shell, "-c", response.content], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    round.exec_ms = Math.round(performance.now() - execStart);
    round.execution = { command: response.content, exit_code: exitCode, shell };
    entry.outcome = exitCode === 0 ? "success" : "error";
    return exitCode;
  } finally {
    addRound(entry, round);
    try {
      appendLogEntry(wrapHome, entry);
    } catch {
      // Logging must never break the tool
    }
  }
}
