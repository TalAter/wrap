import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryEntry = { fact: string };

const MEMORY_FILE = "memory.json";

/** Load memory entries from disk. Returns [] if file doesn't exist. Throws on corrupt JSON. */
export function loadMemory(wrapHome: string): MemoryEntry[] {
  const path = join(wrapHome, MEMORY_FILE);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error("Memory error: could not read memory.json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Memory error: memory.json contains invalid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Memory error: memory.json must contain a JSON array");
  }

  return parsed as MemoryEntry[];
}

/** Write memory entries to disk. Creates directory lazily. */
export function saveMemory(wrapHome: string, entries: MemoryEntry[]): void {
  mkdirSync(wrapHome, { recursive: true });
  const path = join(wrapHome, MEMORY_FILE);
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

/** Append new entries to existing memory on disk. */
export function appendMemory(wrapHome: string, newEntries: MemoryEntry[]): void {
  const existing = loadMemory(wrapHome);
  saveMemory(wrapHome, [...existing, ...newEntries]);
}
