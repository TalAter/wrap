import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CLIPBOARD_PASTE_TOOLS, CLIPBOARD_TOOLS } from "../core/clipboard.ts";
import { loadWatchlist, VALID_TOOL_NAME } from "../watchlist.ts";
import type { Skill, SkillTask } from "./types.ts";

const OLDEST_COUNT = 20;
const NEWEST_COUNT = 30;

type Entry = { name: string; isDir: boolean; mtimeMs: number };

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

/** Tools probed on every run via `which`. */
export const PROBED_TOOLS: readonly string[] = [
  // Package managers
  "brew",
  "apt",
  "dnf",
  "pacman",
  "yum",
  // Core tools
  "git",
  "docker",
  "kubectl",
  "python3",
  "node",
  "bun",
  "curl",
  "wget",
  "jq",
  "tldr",
  "rg",
  "fd",
  "bat",
  "eza",
  // Text extraction
  "textutil",
  "lynx",
  "w3m",
  // Clipboard
  ...CLIPBOARD_TOOLS,
  ...CLIPBOARD_PASTE_TOOLS,
];

function buildTasks(): SkillTask[] {
  const tasks: SkillTask[] = [
    { command: "pwd" },
    {
      command: "ls",
      run: async () => {
        const output = await listCwdFiles(process.cwd());
        if (!output) return null;
        return { output, exitCode: 0 };
      },
    },
  ];

  const watchlist = loadWatchlist();
  const extras = watchlist.map((e) => e.tool);
  const allTools = [...new Set([...PROBED_TOOLS, ...extras])].filter((t) =>
    VALID_TOOL_NAME.test(t),
  );
  if (allTools.length > 0) {
    // `|| true` so any-missing-tool (which exits 1) doesn't cause the
    // runner to drop the partial hit/miss listing we actually want.
    tasks.push({ command: `which ${allTools.join(" ")} || true` });
  }

  return tasks;
}

export const discoverySkill: Skill = {
  name: "discovery",
  trigger: { kind: "always" },
  tasks: buildTasks,
};
