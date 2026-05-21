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
import { ensureTempDir, formatSize } from "./fs/temp.ts";
import { initProvider } from "./llm/index.ts";
import { resolveProvider } from "./llm/resolve-provider.ts";
import { formatProvider } from "./llm/types.ts";
import type { Turn } from "./logging/entry.ts";
import {
  assembleContinuationChain,
  findContinuationParent,
  readLogEntries,
} from "./logging/lookup.ts";
import { ensureMemory } from "./memory/memory.ts";
import { runSession } from "./session/session.ts";
import { SKILLS } from "./skills/index.ts";
import { dispatch } from "./subcommands/dispatch.ts";
import { options } from "./subcommands/registry.ts";

const MODIFIER_SPECS: readonly ModifierSpec[] = options.map((o) => ({
  name: o.id,
  flags: [o.flag, ...(o.aliases ?? [])],
  takesValue: o.takesValue,
}));

export async function main() {
  try {
    const { modifiers, input } = parseArgs(process.argv, MODIFIER_SPECS);

    // --version writes plain stdout — no themed chrome. Skip the OSC 11
    // background-color probe so terminals that reply slowly (e.g. Ubuntu
    // over SSH) don't leak the orphan reply into the parent shell as
    // "^[]11;rgb:...^G" after wrap exits.
    const isVersion = input.type === "flag" && (input.flag === "--version" || input.flag === "-v");

    // Early theme: WRAP_THEME env + cache work before config is loaded.
    // Covers --help, the wizard, and any other pre-config code path.
    if (!isVersion) setTheme(resolveTheme(await resolveAppearance(undefined)));

    // Seed config from CLI + env + defaults so we have an initial state
    // even before reading config file. The session path re-resolves with
    // file config layered in below.
    setConfig(resolveSettings(modifiers, process.env, {}));

    if (input.type === "flag") {
      await dispatch(input.flag, input.args);
      return;
    }

    // Resolve continuation BEFORE materializing stdin or loading config so
    // failures (no log, parent had a pipe) exit fast without side effects.
    const continuation = getConfig().continue ? resolveContinuation() : undefined;

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
    const appearance = await resolveAppearance(getConfig().appearance);
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

    const memory = await ensureMemory(provider);

    const cwd = resolvePath(process.cwd()) ?? process.cwd();

    // The interactive composer will override this to "tui" on submit;
    // "argv" is the default whenever a prompt actually came through argv,
    // "pipe" covers the prompt-less pipe case.
    const inputSource: "argv" | "pipe" | "tui" =
      input.type === "prompt" ? "argv" : attachedInputBytes ? "pipe" : "argv";

    process.exitCode = await runSession(prompt, provider, {
      memory,
      cwd,
      resolvedProvider: resolved,
      skills: SKILLS,
      attachedInputPath,
      attachedInputSize,
      attachedInputPreview,
      attachedInputTruncated,
      inputSource,
      continuationParent: continuation,
    });
  } catch (e) {
    chrome(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

/**
 * `-c` was set on argv. Look up the parent entry, refuse if the parent's
 * stdin can't be replayed, walk the chain, and return the bundle the session
 * needs to seed its transcript. Throws `Error("Continue error: …")` on
 * failure — surfaced via main()'s top-level catch.
 */
function resolveContinuation(): {
  parentId: string;
  assembledTurns: Turn[];
  parentPrompt: string;
} {
  const entries = readLogEntries();
  const parent = findContinuationParent(entries, process.ppid);
  if (parent === null) {
    throw new Error("Continue error: no previous wrap run found.");
  }
  if (parent.attached_input) {
    throw new Error("Continue error: previous run had piped input that's no longer available.");
  }
  const assembledTurns = assembleContinuationChain(entries, parent);
  const firstUserTurn = parent.turns.find(
    (t): t is Extract<Turn, { kind: "user" }> => t.kind === "user",
  );
  return { parentId: parent.id, assembledTurns, parentPrompt: firstUserTurn?.text ?? "" };
}
