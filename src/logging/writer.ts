import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "./entry.ts";
import { serializeEntry } from "./entry.ts";

export function appendLogEntry(wrapHome: string, entry: LogEntry): void {
  const logsDir = join(wrapHome, "logs");
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(join(logsDir, "wrap.jsonl"), `${serializeEntry(entry)}\n`);
}
