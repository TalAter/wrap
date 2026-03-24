import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getWrapHome } from "../core/home.ts";
import { hasJq, isTTY } from "../core/output.ts";
import type { Subcommand } from "./types.ts";

type Writer = (parsed: object[]) => Promise<void>;

function readLog(n: number | null): { valid: object[]; corrupt: number } {
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

function runLogCmd(writer: Writer): (arg: string | number | null) => Promise<void> {
  return async (arg) => {
    const n = typeof arg === "number" ? arg : null;

    if (n === 0) return;

    const { valid, corrupt } = readLog(n);

    if (valid.length === 0 && corrupt === 0) {
      process.stderr.write("No log entries yet.\n");
      return;
    }

    if (valid.length > 0) {
      await writer(valid);
    }

    if (corrupt > 0) {
      process.stderr.write(
        `Warning: skipped ${corrupt} corrupt log ${corrupt === 1 ? "entry" : "entries"}\n`,
      );
    }
  };
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

export const logCmd: Subcommand = {
  flag: "--log",
  description: "Show raw JSONL log entries",
  usage: "w --log [N]",
  arg: { name: "N", type: "number", required: false },
  run: runLogCmd(writeRaw),
};

export const logPrettyCmd: Subcommand = {
  flag: "--log-pretty",
  description: "Show formatted log entries",
  usage: "w --log-pretty [N]",
  arg: { name: "N", type: "number", required: false },
  run: runLogCmd(writePretty),
};
