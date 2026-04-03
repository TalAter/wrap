import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const OLDEST_COUNT = 20;
const NEWEST_COUNT = 30;

type Entry = { name: string; isDir: boolean; mtimeMs: number };

/** Count actual file entries, excluding omission markers and summary lines. */
export function countCwdFiles(cwdFiles: string): number {
  return cwdFiles.split("\n").filter((l) => !l.startsWith("...") && !l.startsWith("(")).length;
}

/** List CWD files sorted by mtime. Returns oldest 20 + newest 30 if >50 entries. */
export async function listCwdFiles(cwd: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(cwd);
  } catch {
    return undefined;
  }

  if (names.length === 0) return undefined;

  const results = await Promise.all(
    names.map(async (name): Promise<Entry | null> => {
      try {
        const s = await lstat(join(cwd, name));
        return { name, isDir: s.isDirectory(), mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const entries = results.filter((e): e is Entry => e !== null);
  if (entries.length === 0) return undefined;

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const total = entries.length;
  let selected: Entry[];

  if (total <= OLDEST_COUNT + NEWEST_COUNT) {
    selected = entries;
  } else {
    const oldest = entries.slice(0, OLDEST_COUNT);
    const newest = entries.slice(total - NEWEST_COUNT);
    selected = [...oldest, ...newest];
  }

  const lines = selected.map((e) => (e.isDir ? `${e.name}/` : e.name));

  if (total > OLDEST_COUNT + NEWEST_COUNT) {
    const omitted = total - (OLDEST_COUNT + NEWEST_COUNT);
    lines.splice(OLDEST_COUNT, 0, `... (${omitted} entries omitted) ...`);
    lines.push(`(showing ${OLDEST_COUNT + NEWEST_COUNT} of ${total} entries)`);
  }

  return lines.join("\n");
}
