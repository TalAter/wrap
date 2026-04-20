import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chrome, hasJq, isTTY } from "../core/output.ts";
import { getWrapHome } from "../fs/home.ts";
import type { Command } from "./types.ts";

type Writer = (parsed: object[]) => Promise<void>;

export function readLog(n: number | null): { valid: object[]; corrupt: number } {
  const logPath = join(getWrapHome(), "logs", "wrap.jsonl");

  if (!existsSync(logPath)) {
    return { valid: [], corrupt: 0 };
  }

  const content = readFileSync(logPath, "utf-8").trimEnd();
  if (!content) return { valid: [], corrupt: 0 };

  let rawLines = content.split("\n");
  if (n !== null) {
    rawLines = rawLines.slice(-n);
  }

  const valid: object[] = [];
  let corrupt = 0;

  for (const line of rawLines) {
    try {
      valid.push(JSON.parse(line));
    } catch {
      corrupt++;
    }
  }

  return { valid, corrupt };
}

export function searchEntries(entries: object[], term: string): object[] {
  const lower = term.toLowerCase();
  return entries.filter((e) => JSON.stringify(e).toLowerCase().includes(lower));
}

type ParsedArgs = { n: number | null; search: string | null; raw: boolean };

function parseArgs(args: string[]): ParsedArgs | null {
  let n: number | null = null;
  let search: string | null = null;
  let raw = false;

  for (const arg of args) {
    if (arg === "--raw") {
      raw = true;
    } else if (/^-\d+$/.test(arg)) {
      chrome("Invalid argument: N must be a non-negative integer.");
      chrome("Usage: w --log [search] [N] [--raw]");
      return null;
    } else {
      const parsed = Number.parseInt(arg, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && String(parsed) === arg) {
        n = parsed;
      } else if (arg === "") {
        // Empty string search treated as no search
      } else if (search === null) {
        search = arg;
      } else {
        chrome("Only one search term allowed.");
        chrome("Usage: w --log [search] [N] [--raw]");
        return null;
      }
    }
  }

  return { n, search, raw };
}

const writeRaw: Writer = async (entries) => {
  process.stdout.write(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
};

const writePretty: Writer = async (entries) => {
  if (isTTY() && hasJq()) {
    const jsonl = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const proc = Bun.spawn(["jq", "-C", "."], {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.stdin.write(jsonl);
    proc.stdin.end();
    await proc.exited;
    return;
  }

  process.stdout.write(`${entries.map((e) => JSON.stringify(e, null, 2)).join("\n\n")}\n`);
};

export const logCmd: Command = {
  kind: "command",
  flag: "--log",
  id: "log",
  description: "Show log entries",
  usage: "w --log [search] [N] [--raw]",
  help: [
    "Arguments:",
    "  search    Filter entries containing this term",
    "  N         Show only the last N entries",
    "  --raw     Output raw JSONL instead of pretty-printed",
  ].join("\n"),
  run: async (args) => {
    const parsed = parseArgs(args);
    if (!parsed) {
      process.exitCode = 1;
      return;
    }
    const { n, search, raw } = parsed;
    const writer = raw || !isTTY() ? writeRaw : writePretty;

    if (n === 0) return;

    // Search reads all lines; no-search preserves raw-line N semantics
    const { valid, corrupt } = readLog(search ? null : n);

    if (valid.length === 0 && corrupt === 0) {
      chrome("No log entries yet.");
      return;
    }

    let results = search ? searchEntries(valid, search) : valid;
    if (search && n !== null) results = results.slice(-n);

    if (results.length === 0) {
      chrome(search ? "No matching log entries." : "No log entries yet.");
      return;
    }

    await writer(results);

    if (corrupt > 0) {
      chrome(`Warning: skipped ${corrupt} corrupt log ${corrupt === 1 ? "entry" : "entries"}`);
    }
  },
};
