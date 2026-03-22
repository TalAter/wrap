import type { Provider } from "../llm/types.ts";
import { parseResponse } from "./parse-response.ts";

/** Returns the process exit code. Caller is responsible for process.exit(). */
export async function runQuery(prompt: string, provider: Provider): Promise<number> {
  const raw = await provider.runCommandPrompt(prompt);
  const response = parseResponse(raw);

  if (response.type === "answer") {
    if (response.answer) console.log(response.answer);
    return 0;
  }

  if (response.type === "probe") {
    console.error("Probe commands are not yet supported.");
    return 1;
  }

  // type === "command"
  if (!response.command) {
    console.error("LLM returned a command response with no command.");
    return 1;
  }
  if (response.risk_level !== "low") {
    console.error(`Command requires confirmation (not yet supported): ${response.command}`);
    return 1;
  }
  const shell = process.env.SHELL || "sh";
  const proc = Bun.spawn([shell, "-c", response.command], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return await proc.exited;
}
