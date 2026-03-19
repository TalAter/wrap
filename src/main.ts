import { loadConfig } from "./config.ts";
import { initLLM } from "./llm.ts";

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
    const output = await llm(prompt);
    // TODO: execute the command and let its stdout flow through.
    // Writing LLM response to stdout is a temporary scaffold.
    console.log(output);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
