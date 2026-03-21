import { loadConfig } from "./config/config.ts";
import { parseInput } from "./core/input.ts";
import { parseResponse } from "./core/parse-response.ts";
import { initLLM } from "./providers/llm.ts";

export async function main() {
  try {
    const input = parseInput(process.argv);

    if (!input.prompt) {
      console.error("Usage: wrap <prompt>");
      process.exit(1);
    }

    const config = loadConfig();

    if (!config.provider) {
      console.error("Config error: no provider configured.");
      process.exit(1);
    }

    const llm = initLLM(config.provider);
    const raw = await llm(input.prompt);
    const response = parseResponse(raw);

    if (response.type === "answer") {
      if (response.answer) console.error(response.answer);
      process.exit(0);
    }

    if (response.type === "probe") {
      console.error("Probe commands are not yet supported.");
      process.exit(1);
    }

    // type === "command"
    if (!response.command) {
      console.error("LLM returned a command response with no command.");
      process.exit(1);
    }
    if (response.risk_level !== "low") {
      console.error(`Command requires confirmation (not yet supported): ${response.command}`);
      process.exit(1);
    }
    const shell = process.env.SHELL || "sh";
    const proc = Bun.spawn([shell, "-c", response.command], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    process.exit(await proc.exited);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
