import { appendWrapFile } from "../core/home-dir.ts";
import type { LogEntry } from "./entry.ts";
import { serializeEntry } from "./entry.ts";

export function appendLogEntry(wrapHome: string, entry: LogEntry): void {
  appendWrapFile("logs/wrap.jsonl", `${serializeEntry(entry)}\n`, wrapHome);
}
