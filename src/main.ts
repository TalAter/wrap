import { loadConfig } from "./config/config.ts";
import { getWrapHome } from "./core/home.ts";
import { parseInput } from "./core/input.ts";
import { runQuery } from "./core/query.ts";
import { initProvider } from "./llm/index.ts";
import { ensureMemory } from "./memory/memory.ts";

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

    const provider = initProvider(config.provider);
    const memory = await ensureMemory(provider, getWrapHome());
    process.exit(await runQuery(input.prompt, provider, memory));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
