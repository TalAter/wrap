export const CLIPBOARD_TOOLS = [
  "wl-copy", // Linux Wayland
  "xclip", // Linux X11
  "xsel", // Linux X11
  "pbcopy", // macOS
  "clip.exe", // Windows / WSL
] as const;

export const CLIPBOARD_PASTE_TOOLS = ["pbpaste", "wl-paste"] as const;

type ClipboardTool = (typeof CLIPBOARD_TOOLS)[number];

// Keyed by bare name so TypeScript's exhaustiveness flags missing entries
// when a new tool is added to CLIPBOARD_TOOLS.
const CLIPBOARD_ARGS: Record<ClipboardTool, readonly string[]> = {
  "wl-copy": [],
  xclip: ["-selection", "clipboard"],
  xsel: ["-ib"],
  pbcopy: [],
  "clip.exe": [],
};

// `undefined` = never resolved; `null` = resolved to "no tool available".
let cached: ClipboardTool | null | undefined;

type WhichFn = (cmd: string) => string | null;

type ResolveDeps = { which?: WhichFn };

function defaultWhich(cmd: string): string | null {
  try {
    return Bun.which(cmd);
  } catch {
    return null;
  }
}

export function resolveClipboardTool(deps: ResolveDeps = {}): ClipboardTool | null {
  if (cached !== undefined) return cached;
  const which = deps.which ?? defaultWhich;
  for (const tool of CLIPBOARD_TOOLS) {
    if (which(tool)) {
      cached = tool;
      return cached;
    }
  }
  cached = null;
  return cached;
}

/** Test-only: reset the module cache. */
export function _resetClipboardCacheForTests(): void {
  cached = undefined;
}

type CopyDeps = ResolveDeps & { spawn?: typeof Bun.spawn };

/**
 * Write `text` to the system clipboard using the resolved tool. Silent on
 * failure by design — the dialog flips the label regardless of spawn outcome,
 * and a failed ENOENT race or stdin-after-exit write would otherwise surface
 * via unhandled rejection and break that contract.
 *
 * Non-blocking: proc.unref() releases Bun's grip immediately so a hung xclip
 * (X11 selection wait) or clip.exe (WSL interop stall) cannot wedge the
 * dialog or block process exit.
 */
export function copyToClipboard(text: string, deps: CopyDeps = {}): void {
  try {
    const tool = resolveClipboardTool(deps);
    if (!tool) return;
    const payload = text.replace(/\n$/, "");
    const spawn = deps.spawn ?? Bun.spawn;
    const proc = spawn([tool, ...CLIPBOARD_ARGS[tool]], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    // FileSink.write/end return number | Promise<number>. Catch the async
    // path so a SIGPIPE / already-exited child doesn't surface as an
    // unhandled rejection and break the silent-failure contract.
    const swallow = (r: number | Promise<number>) => {
      if (typeof r !== "number") r.catch(() => {});
    };
    swallow(proc.stdin.write(payload));
    swallow(proc.stdin.end());
    proc.unref();
  } catch {
    // Silent — see fn docstring.
  }
}
