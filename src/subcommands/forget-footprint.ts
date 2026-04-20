import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dirStats, formatSize } from "../fs/temp.ts";
import { loadMemory } from "../memory/memory.ts";
import { countFacts } from "../memory/types.ts";

export type Footprint =
  | { state: "empty" }
  | { state: "unreadable" }
  | { state: "ok"; count: number; bytes: number };

export type Unit = "facts" | "entries" | "files" | "dirs";

const SCRATCH_PREFIX = "wrap-scratch-";

/** Footprint of memory.json (fact count) + total bytes of memory.json + tool-watchlist.json. */
export function memoryFootprint(wrapHome: string): Footprint {
  const memPath = join(wrapHome, "memory.json");
  const wlPath = join(wrapHome, "tool-watchlist.json");
  const memBytes = fileBytes(memPath);
  const wlBytes = fileBytes(wlPath);
  if (memBytes === 0 && wlBytes === 0) return { state: "empty" };

  let count = 0;
  if (memBytes > 0) {
    try {
      count = countFacts(loadMemory(wrapHome));
    } catch {
      return { state: "unreadable" };
    }
  }
  return { state: "ok", count, bytes: memBytes + wlBytes };
}

/** Footprint of ~/.wrap/logs/wrap.jsonl — streamed line count + byte size. */
export function logsFootprint(wrapHome: string): Footprint {
  const path = join(wrapHome, "logs", "wrap.jsonl");
  const bytes = fileBytes(path);
  if (bytes === 0) return { state: "empty" };
  const content = readFileSync(path, "utf-8");
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  const count = trimmed.length === 0 ? 0 : trimmed.split("\n").length;
  if (count === 0) return { state: "empty" };
  return { state: "ok", count, bytes };
}

/** Footprint of ~/.wrap/cache/ — recursive file count + total bytes. */
export function cacheFootprint(wrapHome: string): Footprint {
  const { files, bytes } = dirStats(join(wrapHome, "cache"));
  if (files === 0) return { state: "empty" };
  return { state: "ok", count: files, bytes };
}

/** Footprint of `$TMPDIR/wrap-scratch-*` — matching dir count + recursive bytes. */
export function scratchFootprint(tmpBase: string): Footprint {
  let entries: string[];
  try {
    entries = readdirSync(tmpBase);
  } catch {
    return { state: "empty" };
  }
  let count = 0;
  let bytes = 0;
  for (const name of entries) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(tmpBase, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    count++;
    bytes += dirStats(path).bytes;
  }
  if (count === 0) return { state: "empty" };
  return { state: "ok", count, bytes };
}

const UNIT_LABEL: Record<Unit, { singular: string; plural: string }> = {
  facts: { singular: "fact", plural: "facts" },
  entries: { singular: "entry", plural: "entries" },
  files: { singular: "file", plural: "files" },
  dirs: { singular: "dir", plural: "dirs" },
};

export function formatFootprint(unit: Unit, fp: Footprint): string {
  if (fp.state === "empty") return "(empty)";
  if (fp.state === "unreadable") return "(unreadable)";
  const { singular, plural } = UNIT_LABEL[unit];
  const noun = fp.count === 1 ? singular : plural;
  const countStr = fp.count.toLocaleString("en-US");
  return `(${countStr} ${noun}, ${formatSize(fp.bytes)})`;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
