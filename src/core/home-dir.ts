import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWrapHome } from "./home.ts";

/**
 * Shared filesystem helpers for anything under $WRAP_HOME. All writes create
 * parent directories lazily so callers never have to sequence `mkdirSync` +
 * write by hand. Path base defaults to `getWrapHome()`; pass an explicit
 * `home` to scope to a different root (used by modules that thread an
 * already-resolved wrapHome through their own APIs).
 */

function resolve(relPath: string, home?: string): string {
  return join(home ?? getWrapHome(), relPath);
}

function ensureParent(absPath: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
}

/** Read a file relative to $WRAP_HOME. Returns null if the file does not exist. */
export function readWrapFile(relPath: string, home?: string): string | null {
  const path = resolve(relPath, home);
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Write a file relative to $WRAP_HOME, creating parent directories as needed. */
export function writeWrapFile(relPath: string, content: string, home?: string): void {
  const path = resolve(relPath, home);
  ensureParent(path);
  writeFileSync(path, content);
}

/** Append to a file relative to $WRAP_HOME, creating parent directories as needed. */
export function appendWrapFile(relPath: string, content: string, home?: string): void {
  const path = resolve(relPath, home);
  ensureParent(path);
  appendFileSync(path, content);
}
