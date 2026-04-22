import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getWrapHome } from "../fs/home.ts";
import { chrome } from "./output.ts";

export type EditorMeta = {
  displayName: string;
  /** Flag that forces a GUI editor to wait for the file to be closed.
   *  Omit for terminal-owning editors (they block naturally). */
  waitFlag?: string;
  /** GUI editors fork instantly and detach from the controlling terminal —
   *  they need the wait flag AND stay out of the reducer's editor-handoff
   *  flow (Ink doesn't unmount). */
  gui?: boolean;
};

export type ResolvedEditor = {
  /** Absolute path (or bare name if $VISUAL/$EDITOR is a bare command). */
  path: string;
  /** Basename with .exe stripped — the EDITORS key. */
  key: string;
  /** Full metadata: either a known EDITORS entry or the unknown fallback. */
  meta: EditorMeta;
};

/**
 * Known editors keyed by basename. Order of iteration matters for the
 * auto-detect fallback — first available wins.
 *
 * GUI editors are forked and detached; without the wait flag they exit
 * instantly and we read an empty temp file. Editors without a documented
 * wait flag are deliberately omitted here so they fall into the "unknown →
 * terminal-owning" path, which at least surfaces the mismatch obviously
 * instead of silently dropping the buffer.
 */
export const EDITORS: Record<string, EditorMeta> = {
  // GUI
  code: { displayName: "VS Code", waitFlag: "-w", gui: true },
  "code-insiders": { displayName: "VS Code Insiders", waitFlag: "-w", gui: true },
  cursor: { displayName: "Cursor", waitFlag: "-w", gui: true },
  windsurf: { displayName: "Windsurf", waitFlag: "-w", gui: true },
  codium: { displayName: "VSCodium", waitFlag: "-w", gui: true },
  antigravity: { displayName: "Antigravity", waitFlag: "-w", gui: true },
  subl: { displayName: "Sublime Text", waitFlag: "--wait", gui: true },
  atom: { displayName: "Atom", waitFlag: "--wait", gui: true },
  // Terminal-owning
  vim: { displayName: "Vim" },
  nvim: { displayName: "Neovim" },
  nano: { displayName: "Nano" },
  emacs: { displayName: "Emacs" },
  hx: { displayName: "Helix" },
  helix: { displayName: "Helix" },
  micro: { displayName: "Micro" },
  vi: { displayName: "Vi" },
};

/** Lookup key from a resolved editor path: basename without .exe.
 *  Handles both POSIX "/" and Windows "\\" separators so a Windows path
 *  (`C:\Program Files\Editor\foo.exe`) collapses to `foo` even when this
 *  code runs on POSIX. */
export function editorKey(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = lastSep >= 0 ? path.slice(lastSep + 1) : basename(path);
  return name.replace(/\.exe$/i, "");
}

// Module-level cache: first call wins for the lifetime of the process.
// `undefined` = never resolved yet; `null` = resolved to "no editor".
let cached: ResolvedEditor | null | undefined;

type Deps = {
  envVisual?: string;
  envEditor?: string;
  which?: (cmd: string) => string | null;
};

function defaultWhich(cmd: string): string | null {
  try {
    return Bun.which(cmd);
  } catch {
    return null;
  }
}

/**
 * Resolve the editor to use for Ctrl-G. Checks $VISUAL then $EDITOR then
 * sweeps through the known editors in declaration order via Bun.which.
 * Returns null when nothing was found; unknown resolved editors fall back
 * to terminal-owning behavior (no wait flag, the editor blocks naturally).
 */
export function resolveEditor(deps: Deps = {}): ResolvedEditor | null {
  if (cached !== undefined) return cached;
  const which = deps.which ?? defaultWhich;

  const envVisual = (deps.envVisual ?? process.env.VISUAL ?? "").trim();
  const envEditor = (deps.envEditor ?? process.env.EDITOR ?? "").trim();

  const envCandidate = envVisual || envEditor;
  if (envCandidate) {
    // $VISUAL / $EDITOR may already be absolute or a bare command.
    const resolved = which(envCandidate) ?? envCandidate;
    const key = editorKey(resolved);
    const meta = EDITORS[key] ?? { displayName: key };
    cached = { path: resolved, key, meta };
    return cached;
  }

  // No env override — sweep the known list in declaration order. First hit
  // wins; short-circuit as soon as Bun.which returns a path.
  for (const key of Object.keys(EDITORS)) {
    const resolved = which(key);
    if (!resolved) continue;
    // biome-ignore lint/style/noNonNullAssertion: key came from Object.keys(EDITORS)
    const meta = EDITORS[key]!;
    cached = { path: resolved, key, meta };
    return cached;
  }

  cached = null;
  return cached;
}

/** Test-only: reset the module cache. */
export function _resetEditorCacheForTests(): void {
  cached = undefined;
}

/**
 * Read a file with a brief retry on ENOENT. VS Code (and other editors) do
 * atomic saves by renaming a temp file over the target — there's a short
 * window where the path doesn't resolve. A few retries at small intervals
 * cover that window without blocking meaningfully on the common case.
 */
function readFileWithRetry(filePath: string, maxAttempts = 5, delayMs = 20): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return readFileSync(filePath, "utf-8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || attempt === maxAttempts - 1) throw e;
      Bun.sleepSync(delayMs);
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("readFileWithRetry: unreachable");
}

/**
 * Spawn the resolved editor on a buffer file seeded with `draft`. Awaits exit,
 * reads the file, returns the new buffer text (trailing "\n" trimmed) or
 * null when the editor exited non-zero / wrote nothing / anything went
 * wrong. The caller decides what to do with null (keep current buffer is
 * the rule across all call sites).
 *
 * Buffer path is `$WRAP_HOME/cache/compose.md` — deliberately NOT in
 * $WRAP_TEMP_DIR (/tmp on most systems) because macOS's /private/var/folders
 * has quirky file-watcher behavior that made VS Code report our freshly-
 * written temp file as "deleted" mid-edit, and because stable home-dir
 * paths avoid the read-after-atomic-rename race editors trigger on save.
 * We still retry readFileSync on ENOENT to cover that window anyway.
 *
 * `signal` lets the caller abort the wait. On abort, proc.unref() releases
 * Bun's grip on the subprocess — GUI editors keep running, Node exits
 * cleanly.
 *
 * Stdio: "inherit" across the board. GUI editors need their real stdio
 * for `-w` wait signaling; terminal-owning editors need it for obvious
 * reasons.
 *
 * Exit-code policy:
 *   0 + non-empty file → replace buffer.
 *   0 + empty file     → keep buffer (return null).
 *   non-zero           → keep buffer (return null).
 */
export async function spawnEditor(
  resolved: ResolvedEditor,
  draft: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cacheDir = join(getWrapHome(), "cache");
  const filePath = join(cacheDir, "compose.md");
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, draft, "utf-8");

    const argv = resolved.meta.waitFlag
      ? [resolved.path, resolved.meta.waitFlag, filePath]
      : [resolved.path, filePath];
    proc = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });

    if (signal) {
      if (signal.aborted) {
        proc.unref();
        return null;
      }
      const exitPromise: Promise<"exited"> = proc.exited.then(() => "exited");
      const abortPromise = new Promise<"aborted">((resolve) => {
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const outcome = await Promise.race([exitPromise, abortPromise]);
      if (outcome === "aborted") {
        proc.unref();
        return null;
      }
    } else {
      await proc.exited;
    }

    const exitCode = proc.exitCode;
    if (exitCode !== 0) {
      chrome(`${resolved.meta.displayName} exited with code ${exitCode} — keeping current draft`);
      return null;
    }
    const raw = readFileWithRetry(filePath);
    const trimmed = raw.replace(/\n$/, "");
    return trimmed.length === 0 ? null : trimmed;
  } catch (e) {
    chrome(`Editor error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
