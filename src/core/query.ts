import { NoObjectGeneratedError } from "ai";
import { assembleCommandPrompt } from "../llm/context.ts";
import { runCommandPrompt } from "../llm/index.ts";
import type { Provider, ProviderConfig } from "../llm/types.ts";
import { addRound, createLogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendMemory } from "../memory/memory.ts";
import type { Memory } from "../memory/types.ts";
import { PROMPT_HASH } from "../prompt.optimized.ts";
import { getWrapHome } from "./home.ts";
import { chrome } from "./output.ts";

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

/** Returns the process exit code. Caller is responsible for process.exit(). */
export async function runQuery(
  prompt: string,
  provider: Provider,
  options: {
    memory?: Memory;
    providerConfig: ProviderConfig;
  },
): Promise<number> {
  const wrapHome = getWrapHome();
  const entry = createLogEntry({
    prompt,
    cwd: process.cwd(),
    provider: options.providerConfig,
    promptHash: PROMPT_HASH,
  });
  const round: Round = {};

  try {
    const input = assembleCommandPrompt({
      prompt,
      cwd: process.cwd(),
      memory: options.memory ?? {},
    });

    let response: Awaited<ReturnType<typeof runCommandPrompt>>;
    try {
      response = await runCommandPrompt(provider, input);
    } catch (e) {
      if (!isStructuredOutputError(e)) {
        round.provider_error = e instanceof Error ? e.message : String(e);
        throw e;
      }
      // Retry once with failed output appended
      const retryInput = {
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
      };
      try {
        response = await runCommandPrompt(provider, retryInput);
      } catch (retryErr) {
        round.provider_error = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw retryErr;
      }
    }
    round.parsed = response;

    if (response.memory_updates?.length) {
      appendMemory(wrapHome, response.memory_updates);
      if (response.memory_updates_message) {
        chrome(`🧠 ${response.memory_updates_message}`);
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
    const proc = Bun.spawn([shell, "-c", response.content], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    round.execution = { command: response.content, exit_code: exitCode };
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
