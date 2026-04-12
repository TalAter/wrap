import { statSync } from "node:fs";
import { join } from "node:path";
import { getWrapHome } from "./home.ts";
import { readWrapFile, writeWrapFile } from "./home-dir.ts";

/**
 * TTL-bounded network fetch with a filesystem cache under $WRAP_HOME.
 *
 * - Fresh cache hit: the file exists and `mtime + ttlMs > now`. Returned
 *   as `{ stale: false, content }` without touching the network.
 * - Cache miss or expired: fetch `url`. On success, write to `path` via
 *   `writeWrapFile` (parent directories created on demand) and return
 *   `{ stale: false, content }`.
 * - Fetch failure with a cache file present: return `{ stale: true, content }`.
 *   Caller decides whether to use it.
 * - Fetch failure with no cache file: throws.
 *
 * `stale` is named from the caller's perspective: `true` means "the
 * network call failed and I'm serving you the last known copy."
 */
export async function fetchCached(opts: {
  url: string;
  /** Relative to `$WRAP_HOME/` — e.g. `"cache/models.dev.json"`. */
  path: string;
  ttlMs: number;
}): Promise<{ stale: boolean; content: string }> {
  const { url, path, ttlMs } = opts;

  const cached = readWrapFile(path);
  if (cached !== null && isFresh(path, ttlMs)) {
    return { stale: false, content: cached };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    writeWrapFile(path, content);
    return { stale: false, content };
  } catch (e) {
    if (cached !== null) {
      return { stale: true, content: cached };
    }
    throw e;
  }
}

function isFresh(relPath: string, ttlMs: number): boolean {
  try {
    const { mtimeMs } = statSync(join(getWrapHome(), relPath));
    return mtimeMs + ttlMs > Date.now();
  } catch {
    return false;
  }
}
