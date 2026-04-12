import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptConstants from "../prompt.constants.json";

/**
 * Create a per-invocation temp directory and export its path to
 * `process.env.WRAP_TEMP_DIR`. Subsequent spawned shells inherit the env var
 * automatically (Bun.spawn inherits by default). Returns the absolute path.
 *
 * Cleanup is deferred: no exit handler, no signal trap. Rationale: a future
 * resume flow may want to pick up where a previous `w` left off, and the OS
 * cleans `$TMPDIR` on its own schedule as a backstop.
 */
export function createTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "wrap-scratch-"));
  process.env.WRAP_TEMP_DIR = path;
  return path;
}

/**
 * Build the temp-dir section that goes into the prompt context each round.
 * Lists every entry under `$WRAP_TEMP_DIR` recursively, with file sizes for
 * leaves. Returns an empty-state section when the dir is empty or unset.
 *
 * The section uses the env-var form (`$WRAP_TEMP_DIR`) rather than the
 * literal path. The LLM must never see the absolute path, so commands it
 * generates remain portable and match the form shown in the dialog.
 */
export function formatTempDirSection(): string {
  const header = promptConstants.sectionTempDir;
  const dir = process.env.WRAP_TEMP_DIR;
  if (!dir) return `${header}\n${promptConstants.tempDirEmpty}`;

  const lines: string[] = [];
  walk(dir, "", lines);
  if (lines.length === 0) return `${header}\n${promptConstants.tempDirEmpty}`;
  return `${header}\n${lines.join("\n")}`;
}

function walk(root: string, rel: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(join(root, rel));
  } catch {
    return;
  }
  entries.sort();
  for (const name of entries) {
    const childRel = rel ? join(rel, name) : name;
    const absolute = join(root, childRel);
    let info: { isDirectory: boolean; size: number };
    try {
      const s = statSync(absolute);
      info = { isDirectory: s.isDirectory(), size: s.size };
    } catch {
      continue;
    }
    const display = `$WRAP_TEMP_DIR/${childRel}`;
    if (info.isDirectory) {
      out.push(`${display}/`);
      walk(root, childRel, out);
    } else {
      out.push(`${display} (${formatSize(info.size)})`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${Math.round(bytes / (1024 * 1024))}M`;
}
