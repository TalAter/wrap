import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VALID_TOOL_NAME } from "./init-probes.ts";

const WATCHLIST_FILE = "tool-watchlist.json";

export type WatchlistEntry = {
  tool: string;
  added: string; // ISO 8601 date (YYYY-MM-DD) — updated on each re-nomination
};

/** Load the tool watchlist from WRAP_HOME. Returns [] if missing or invalid. */
export function loadWatchlist(wrapHome: string): WatchlistEntry[] {
  const path = join(wrapHome, WATCHLIST_FILE);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: unknown): e is WatchlistEntry =>
        typeof e === "object" &&
        e !== null &&
        "tool" in e &&
        "added" in e &&
        typeof (e as WatchlistEntry).tool === "string" &&
        typeof (e as WatchlistEntry).added === "string" &&
        VALID_TOOL_NAME.test((e as WatchlistEntry).tool),
    );
  } catch {
    return [];
  }
}

/** Add tools to the watchlist. Re-nominations update the date (useful for pruning). */
export function addToWatchlist(wrapHome: string, tools: string[]): void {
  const valid = tools.filter((t) => VALID_TOOL_NAME.test(t));
  if (valid.length === 0) return;

  const existing = loadWatchlist(wrapHome);
  const today = new Date().toISOString().slice(0, 10);
  const nominated = new Set(valid);

  // Update date for re-nominated tools, keep others unchanged
  const updated = existing.map((e) => (nominated.has(e.tool) ? { ...e, added: today } : e));
  const known = new Set(existing.map((e) => e.tool));
  const additions = valid.filter((t) => !known.has(t)).map((tool) => ({ tool, added: today }));

  writeFileSync(
    join(wrapHome, WATCHLIST_FILE),
    `${JSON.stringify([...updated, ...additions], null, 2)}\n`,
  );
}
