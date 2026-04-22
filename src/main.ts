import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureConfig } from "./config/ensure.ts";
import { applyModelOverride, resolveSettings } from "./config/resolve.ts";
import { getConfig, setConfig } from "./config/store.ts";
import { buildAttachedInputPreview, readAttachedInput } from "./core/attached-input.ts";
import { resolveAppearance } from "./core/detect-appearance.ts";
import { type ModifierSpec, parseArgs } from "./core/input.ts";
import { chrome } from "./core/output.ts";
import { resolvePath } from "./core/paths.ts";
import { resolveTheme, setTheme } from "./core/theme.ts";
import { verbose } from "./core/verbose.ts";
import { countCwdFiles, listCwdFiles } from "./discovery/cwd-files.ts";
import { probeTools } from "./discovery/init-probes.ts";
import { loadWatchlist } from "./discovery/watchlist.ts";
import { getWrapHome } from "./fs/home.ts";
import { ensureTempDir, formatSize } from "./fs/temp.ts";
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

    const attachedInputBytes = await readAttachedInput();

    // --help when we have nothing to work with: no args, no pipe, no TTY
    // (scripts / cron). `none + TTY` falls through to the interactive
    // composer; `none + pipe` falls through to runSession with prompt="".
    if (input.type === "none" && !attachedInputBytes && !process.stdin.isTTY) {
      await dispatch("--help", []);
      return;
    }

    const prompt = input.type === "prompt" ? input.prompt : "";

    const { config: fileConfig, justCreated } = await ensureConfig();
    if (justCreated && input.type === "none" && !attachedInputBytes) {
      // Fresh config + no real request to run: don't auto-launch compose,
      // just tell the user they're ready and exit cleanly.
      chrome("✓ wrap configured — run w again to start wrapping");
      return;
    }
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

    let attachedInputPath: string | undefined;
    let attachedInputSize: number | undefined;
    let attachedInputPreview: string | undefined;
    let attachedInputTruncated = false;
    if (attachedInputBytes) {
      // Materializing the pipe to disk is the only non-shell-exec path that
      // needs the temp dir, so create it eagerly here rather than waiting for
      // ensureTempDir's lazy call inside executeShellCommand.
      const tempDir = ensureTempDir();
      attachedInputPath = join(tempDir, "input");
      // Mode passed upfront so the initial file is never more permissive than
      // 0o600 (umask can only further restrict). Explicit chmod afterwards
      // guarantees exactly 0o600 even under a weird umask, so the next process
      // reading this path can rely on the mode.
      await writeFile(attachedInputPath, attachedInputBytes, { mode: 0o600 });
      await chmod(attachedInputPath, 0o600);
      attachedInputSize = attachedInputBytes.byteLength;
      const built = buildAttachedInputPreview(
        attachedInputBytes,
        getConfig().maxAttachedInputChars,
      );
      attachedInputPreview = built.preview;
      attachedInputTruncated = built.truncated;
      verbose(`Input file: ${attachedInputPath} (${formatSize(attachedInputSize)})`);
    }

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

    // The interactive composer will override this to "tui" on submit;
    // "argv" is the default whenever a prompt actually came through argv,
    // "pipe" covers the prompt-less pipe case.
    const inputSource: "argv" | "pipe" | "tui" =
      input.type === "prompt" ? "argv" : attachedInputBytes ? "pipe" : "argv";

    process.exitCode = await runSession(prompt, provider, {
      memory,
      cwd,
      resolvedProvider: resolved,
      tools,
      cwdFiles,
      attachedInputPath,
      attachedInputSize,
      attachedInputPreview,
      attachedInputTruncated,
      inputSource,
    });
  } catch (e) {
    chrome(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
