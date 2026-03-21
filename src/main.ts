import { loadConfig } from "./config.ts";
import { initLLM } from "./llm.ts";
import { type Response, ResponseSchema } from "./response.schema.ts";

function parseResponse(raw: string): Response {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("LLM returned invalid JSON.");
  }
  const result = ResponseSchema.safeParse(json);
  if (!result.success) {
    throw new Error("LLM returned an invalid response.");
  }
  return result.data;
}

export async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.error("Usage: wrap <prompt>");
      process.exit(1);
    }

    const config = loadConfig();

    if (!config.provider) {
      console.error("Config error: no provider configured.");
      process.exit(1);
    }

    const llm = initLLM(config.provider);
    const prompt = args.join(" ");
    const raw = await llm(prompt);
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
