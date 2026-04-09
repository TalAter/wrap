import { loadConfig } from "./config/config.ts";
import { getWrapHome } from "./core/home.ts";
import { type ModifierSpec, parseArgs } from "./core/input.ts";
import { chrome } from "./core/output.ts";
import { resolvePath } from "./core/paths.ts";
import { readPipedInput } from "./core/piped-input.ts";
import { createTempDir } from "./core/temp-dir.ts";
import { initVerbose, verbose } from "./core/verbose.ts";
import { countCwdFiles, listCwdFiles } from "./discovery/cwd-files.ts";
import { probeTools } from "./discovery/init-probes.ts";
import { loadWatchlist } from "./discovery/watchlist.ts";
import { initProvider } from "./llm/index.ts";
import { resolveProvider } from "./llm/resolve-provider.ts";
import { formatProvider } from "./llm/types.ts";
import { ensureMemory } from "./memory/memory.ts";
import { runSession } from "./session/session.ts";
import { dispatch } from "./subcommands/dispatch.ts";

const MODIFIER_SPECS: readonly ModifierSpec[] = [
  { name: "verbose", flags: ["--verbose"], takesValue: false },
  { name: "modelOverride", flags: ["--model", "--provider"], takesValue: true },
];

export async function main() {
  try {
    const { modifiers, input } = parseArgs(process.argv, MODIFIER_SPECS);

    if (input.type === "flag") {
      await dispatch(input.flag, input.args);
      return;
    }

    const pipedInput = await readPipedInput();

    if (input.type === "none" && !pipedInput) {
      await dispatch("--help", []);
      return;
    }

    const prompt = input.type === "prompt" ? input.prompt : "";

    const config = loadConfig();
    initVerbose(modifiers.flags.has("verbose") || config.verbose === true);

    // CLI flag wins over WRAP_MODEL env var. resolveProvider then parses the
    // raw string and short-circuits to the test sentinel if WRAP_TEST_RESPONSE
    // is set, regardless of config.
    const override = modifiers.values.get("modelOverride") ?? process.env.WRAP_MODEL;
    const resolved = resolveProvider(config, override);
    const label = formatProvider(resolved);
    verbose(`Config loaded (${label})`);

    const provider = initProvider(resolved);
    verbose(`Provider initialized (${label})`);

    const tempDir = createTempDir();
    verbose(`Temp dir: ${tempDir}`);

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
      await runSession(prompt, provider, {
        memory,
        cwd,
        resolvedProvider: resolved,
        tools,
        cwdFiles,
        pipedInput,
        maxRounds: config.maxRounds,
        maxCapturedOutputChars: config.maxCapturedOutputChars,
        maxPipedInputChars: config.maxPipedInputChars,
      }),
    );
  } catch (e) {
    chrome(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
