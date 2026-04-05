import { loadConfig } from "./config/config.ts";
import { getWrapHome } from "./core/home.ts";
import { parseArgs } from "./core/input.ts";
import { chrome } from "./core/output.ts";
import { resolvePath } from "./core/paths.ts";
import { readPipedInput } from "./core/piped-input.ts";
import { runQuery } from "./core/query.ts";
import { initVerbose, verbose } from "./core/verbose.ts";
import { countCwdFiles, listCwdFiles } from "./discovery/cwd-files.ts";
import { probeTools } from "./discovery/init-probes.ts";
import { loadWatchlist } from "./discovery/watchlist.ts";
import { initProvider } from "./llm/index.ts";
import { providerLabel } from "./llm/types.ts";
import { ensureMemory } from "./memory/memory.ts";
import { dispatch } from "./subcommands/dispatch.ts";

export async function main() {
  try {
    const { modifiers, input } = parseArgs(process.argv);
    const pipedInput = await readPipedInput();

    if (input.type === "flag") {
      await dispatch(input.flag, input.args);
      return;
    }

    if (input.type === "none" && !pipedInput) {
      await dispatch("--help", []);
      return;
    }

    const prompt = input.type === "prompt" ? input.prompt : "";

    const config = loadConfig();
    initVerbose(modifiers.verbose || config.verbose === true);
    verbose(`Config loaded (${config.provider?.type ?? "no provider"})`);

    if (!config.provider) {
      chrome("Config error: no provider configured.");
      process.exit(1);
    }

    const provider = initProvider(config.provider);
    verbose(`Provider initialized (${providerLabel(config.provider)})`);

    const wrapHome = getWrapHome();
    const watchlist = loadWatchlist(wrapHome);
    const tools = probeTools(watchlist.map((e) => e.tool));
    if (tools) {
      verbose(
        `Tools: ${tools.available.length}/${tools.available.length + tools.unavailable.length} available`,
      );
    }

    const memory = await ensureMemory(provider, wrapHome);

    const cwd = resolvePath(process.cwd()) ?? process.cwd();
    const cwdFiles = await listCwdFiles(cwd);
    if (cwdFiles) {
      verbose(`CWD: ${countCwdFiles(cwdFiles)} files listed`);
    }

    process.exit(
      await runQuery(prompt, provider, {
        memory,
        cwd,
        providerConfig: config.provider,
        tools,
        cwdFiles,
        pipedInput: pipedInput ?? undefined,
        maxRounds: config.maxRounds,
        maxProbeOutputChars: config.maxProbeOutputChars,
        maxPipedInputChars: config.maxPipedInputChars,
      }),
    );
  } catch (e) {
    chrome(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
