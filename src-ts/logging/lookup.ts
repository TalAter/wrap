import { existsSync, readFileSync } from "node:fs";
import { wrapFs } from "../fs/home.ts";
import type { LogEntry, Turn } from "./entry.ts";

/**
 * Read the entire JSONL into memory and parse line-by-line. Malformed lines
 * are skipped — logging never crashes the tool, even on read.
 *
 * Exposed so callers that need multiple ops over the same snapshot (lookup
 * + chain walk for `-c`) can avoid re-reading the file.
 */
export function readLogEntries(): LogEntry[] {
  const path = wrapFs.resolve("logs/wrap.jsonl");
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trimEnd();
  if (!content) return [];
  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {}
  }
  return entries;
}

/**
 * Find the parent entry for a `w -c` invocation. Picks the FIRST match under
 * this priority:
 *
 *   1. Newest entry whose `entry.ppid === ppid` AND `ppid !== 1`. ("Same
 *      shell session." A caller PPID of 1 means orphaned/launchd-reparented
 *      and cannot meaningfully identify a shell — fall through.)
 *   2. Otherwise, the newest entry overall. ("Whatever you last did.")
 *
 * Returns `null` when the log is empty or every line is malformed.
 */
export function findContinuationParent(entries: LogEntry[], ppid: number): LogEntry | null {
  if (entries.length === 0) return null;
  const newest = entries[entries.length - 1] ?? null;
  if (ppid === 1) return newest;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.ppid === ppid) return entry;
  }
  return newest;
}

/**
 * Walk the parent_id chain from `parent` to the chain root and return the
 * concatenated `turns[]` in chronological order (root first, parent last).
 *
 * A `parent_id` that references a missing entry truncates the chain — replay
 * proceeds on whatever survived per [[continuation]].
 */
export function assembleContinuationChain(entries: LogEntry[], parent: LogEntry): Turn[] {
  const byId = new Map<string, LogEntry>();
  for (const e of entries) byId.set(e.id, e);

  const visited = new Set<string>();
  const chain: LogEntry[] = [];
  let current: LogEntry | undefined = parent;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  chain.reverse();
  const turns: Turn[] = [];
  for (const entry of chain) turns.push(...entry.turns);
  return turns;
}
