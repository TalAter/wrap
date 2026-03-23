import type { MemoryFact, Provider, ProviderConfig } from "../llm/types.ts";
import { addRound, createLogEntry, type Round } from "../logging/entry.ts";
import { appendLogEntry } from "../logging/writer.ts";
import { appendMemory } from "../memory/memory.ts";
import { PROMPT_HASH } from "../prompt.optimized.ts";
import { getWrapHome } from "./home.ts";
import { parseResponse } from "./parse-response.ts";

/** Returns the process exit code. Caller is responsible for process.exit(). */
export async function runQuery(
  prompt: string,
  provider: Provider,
  options: {
    memory?: MemoryFact[];
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
    let raw: string;
    try {
      raw = await provider.runCommandPrompt(prompt, options.memory);
    } catch (e) {
      round.provider_error = e instanceof Error ? e.message : String(e);
      throw e;
    }

    let response: ReturnType<typeof parseResponse>;
    try {
      response = parseResponse(raw);
    } catch (e) {
      round.raw_response = raw;
      round.parse_error = e instanceof Error ? e.message : String(e);
      throw e;
    }
    round.parsed = response;

    if (response.memory_updates?.length) {
      appendMemory(wrapHome, response.memory_updates);
      if (response.memory_updates_message) {
        process.stderr.write(`🧠 ${response.memory_updates_message}\n`);
      }
    }

    if (response.type === "answer") {
      if (response.answer) console.log(response.answer);
      entry.outcome = "success";
      return 0;
    }

    if (response.type === "probe") {
      console.error("Probe commands are not yet supported.");
      entry.outcome = "refused";
      return 1;
    }

    // type === "command"
    if (!response.command) {
      console.error("LLM returned a command response with no command.");
      return 1;
    }
    if (response.risk_level !== "low") {
      console.error(`Command requires confirmation (not yet supported): ${response.command}`);
      entry.outcome = "refused";
      return 1;
    }
    const shell = process.env.SHELL || "sh";
    const proc = Bun.spawn([shell, "-c", response.command], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    round.execution = { command: response.command, exit_code: exitCode };
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
