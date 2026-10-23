import { readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { wrapFs } from "../fs/home.ts";

export type DeleteResult = {
  /** True iff at least one real filesystem entry was removed (ENOENT doesn't count). */
  removed: boolean;
  /** Absolute paths that failed to delete for reasons other than ENOENT. */
  errors: string[];
};

const SCRATCH_PREFIX = "wrap-scratch-";

export function deleteMemory(): DeleteResult {
  const result: DeleteResult = { removed: false, errors: [] };
  unlinkIfPresent(wrapFs.resolve("memory.json"), result);
  unlinkIfPresent(wrapFs.resolve("tool-watchlist.json"), result);
  return result;
}

export function deleteLogs(): DeleteResult {
  return rmDir(wrapFs.resolve("logs"));
}

export function deleteCache(): DeleteResult {
  return rmDir(wrapFs.resolve("cache"));
}

export function deleteScratch(tmpBase: string): DeleteResult {
  const result: DeleteResult = { removed: false, errors: [] };
  let entries: string[];
  try {
    entries = readdirSync(tmpBase);
  } catch {
    return result;
  }
  for (const name of entries) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(tmpBase, name);
    const r = rmDir(path);
    if (r.removed) result.removed = true;
    result.errors.push(...r.errors);
  }
  return result;
}

function unlinkIfPresent(path: string, result: DeleteResult): void {
  try {
    unlinkSync(path);
    result.removed = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    result.errors.push(path);
  }
}

function rmDir(path: string): DeleteResult {
  const result: DeleteResult = { removed: false, errors: [] };
  try {
    // `force: true` makes ENOENT silent; we detect "did anything exist?" via a
    // pre-check rather than parsing error codes, since fs.rm recurses into
    // children and could partially succeed.
    let existed = true;
    try {
      readdirSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") existed = false;
    }
    rmSync(path, { recursive: true, force: true });
    if (existed) result.removed = true;
  } catch {
    result.errors.push(path);
  }
  return result;
}
