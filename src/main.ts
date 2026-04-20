import { ensureConfig } from "./config/ensure.ts";
import { applyModelOverride, resolveSettings } from "./config/resolve.ts";
import { getConfig, setConfig } from "./config/store.ts";
import { resolveAppearance } from "./core/detect-appearance.ts";
import { type ModifierSpec, parseArgs } from "./core/input.ts";
import { chrome } from "./core/output.ts";
import { resolvePath } from "./core/paths.ts";
import { readPipedInput } from "./core/piped-input.ts";
import { resolveTheme, setTheme } from "./core/theme.ts";
import { verbose } from "./core/verbose.ts";
import { countCwdFiles, listCwdFiles } from "./discovery/cwd-files.ts";
import { probeTools } from "./discovery/init-probes.ts";
import { loadWatchlist } from "./discovery/watchlist.ts";
import { getWrapHome } from "./fs/home.ts";
import { initProvider } from "./llm/index.ts";
import { resolveProvider } from "./llm/resolve-provider.ts";
import { formatProvider } from "./llm/types.ts";
import { ensureMemory } from "./memory/memory.ts";
import { runSession } from "./session/session.ts";
import { dispatch } from "./subcommands/dispatch.ts";
import { options } from "./subcommands/registry.ts";

const MODIFIER_SPECS: readonly ModifierSpec[] = options.map((o) => ({
  name: o.id,
  flags: [o.flag, ...(o.aliases ?? [])],
  takesValue: o.takesValue,
}));

export async function main() {
  try {
    // Early theme: WRAP_THEME env + cache work before config is loaded.
    // Covers --help, the wizard, and any other pre-config code path.
    setTheme(resolveTheme(resolveAppearance(undefined)));

    const { modifiers, input } = parseArgs(process.argv, MODIFIER_SPECS);

    // Seed config from CLI + env + defaults so we have an initial state
    // even before reading config file. The session path re-resolves with
    // file config layered in below.
    setConfig(resolveSettings(modifiers, process.env, {}));

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

    const fileConfig = await ensureConfig();
    const base = resolveSettings(modifiers, process.env, fileConfig);
    setConfig(applyModelOverride(base, modifiers, process.env));

    // Re-resolve theme now that config.appearance is available.
    const appearance = resolveAppearance(getConfig().appearance);
    setTheme(resolveTheme(appearance));

    const resolved = resolveProvider(getConfig());
    const label = formatProvider(resolved);
    verbose(`Config loaded (${label})`);

    const provider = initProvider(resolved);
    verbose(`Provider initialized (${label})`);

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

    process.exitCode = await runSession(prompt, provider, {
      memory,
      cwd,
      resolvedProvider: resolved,
      tools,
      cwdFiles,
      pipedInput,
    });
  } catch (e) {
    chrome(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
