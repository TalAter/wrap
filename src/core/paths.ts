import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve a path to its canonical absolute form (synchronous).
 * Expands ~, resolves relative paths against `cwd`, resolves symlinks,
 * normalizes /private/var -> /var on macOS.
 * Returns null if the path does not exist on disk.
 */
export function resolvePath(p: string, cwd?: string): string | null {
  try {
    let expanded = p.startsWith("~") ? p.replace("~", homedir()) : p;
    if (cwd && !expanded.startsWith("/")) {
      expanded = resolve(cwd, expanded);
    }
    return realpathSync(expanded);
  } catch {
    return null;
  }
}

/**
 * Display a path with ~ substituted for the home directory prefix.
 * For use in user-facing messages (stderr). Never for storage or prompt injection.
 */
export function prettyPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}
