import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addToWatchlist, loadWatchlist, type WatchlistEntry } from "../src/watchlist.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const WATCHLIST_PATH = join(TEST_HOME, "tool-watchlist.json");

afterEach(() => {
  rmSync(WATCHLIST_PATH, { force: true });
});

describe("loadWatchlist", () => {
  test("returns empty array when file does not exist", () => {
    expect(loadWatchlist()).toEqual([]);
  });

  test("returns empty array when file is empty", () => {
    writeFileSync(WATCHLIST_PATH, "");
    expect(loadWatchlist()).toEqual([]);
  });

  test("loads valid watchlist entries", () => {
    const entries: WatchlistEntry[] = [
      { tool: "sips", added: "2026-03-21" },
      { tool: "convert", added: "2026-03-21" },
    ];
    writeFileSync(WATCHLIST_PATH, JSON.stringify(entries));
    expect(loadWatchlist()).toEqual(entries);
  });

  test("filters out entries with invalid tool names", () => {
    const entries = [
      { tool: "sips", added: "2026-03-21" },
      { tool: "; rm -rf /", added: "2026-03-21" },
      { tool: "convert", added: "2026-03-21" },
    ];
    writeFileSync(WATCHLIST_PATH, JSON.stringify(entries));
    const result = loadWatchlist();
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.tool)).toEqual(["sips", "convert"]);
  });

  test("returns empty array on malformed JSON", () => {
    writeFileSync(WATCHLIST_PATH, "not json{{{");
    expect(loadWatchlist()).toEqual([]);
  });

  test("returns empty array when file contains non-array JSON", () => {
    writeFileSync(WATCHLIST_PATH, '{"tool": "sips"}');
    expect(loadWatchlist()).toEqual([]);
  });

  test("rejects malformed array entries (null, non-object, wrong field types)", () => {
    const mixed = [
      null,
      "string-entry",
      42,
      { tool: 42, added: "2026-04-23" },
      { tool: "git", added: 20260423 },
      { tool: "git", added: "2026-04-23" },
      { tool: "rm -rf /", added: "2026-04-23" },
    ];
    writeFileSync(WATCHLIST_PATH, JSON.stringify(mixed));
    expect(loadWatchlist()).toEqual([{ tool: "git", added: "2026-04-23" }]);
  });
});

describe("addToWatchlist", () => {
  test("creates file with new entries when it does not exist", () => {
    addToWatchlist(["sips", "convert"]);
    const result = loadWatchlist();
    expect(result).toHaveLength(2);
    expect(result[0]?.tool).toBe("sips");
    expect(result[1]?.tool).toBe("convert");
  });

  test("entries have ISO date added field", () => {
    addToWatchlist(["sips"]);
    const result = loadWatchlist();
    expect(result[0]?.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("re-nomination updates the date", () => {
    const existing: WatchlistEntry[] = [{ tool: "sips", added: "2025-01-01" }];
    writeFileSync(WATCHLIST_PATH, JSON.stringify(existing));

    addToWatchlist(["sips", "convert"]);
    const result = loadWatchlist();
    expect(result).toHaveLength(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(result.find((e) => e.tool === "sips")?.added).toBe(today);
    expect(result.find((e) => e.tool === "convert")?.added).toBe(today);
  });

  test("silently drops invalid tool names", () => {
    addToWatchlist(["valid-tool", "; rm -rf /", "$(whoami)", ""]);
    const result = loadWatchlist();
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBe("valid-tool");
  });

  test("re-nominating all tools updates their dates", () => {
    const existing: WatchlistEntry[] = [
      { tool: "sips", added: "2025-01-01" },
      { tool: "convert", added: "2025-01-01" },
    ];
    writeFileSync(WATCHLIST_PATH, JSON.stringify(existing));

    addToWatchlist(["sips", "convert"]);
    const result = loadWatchlist();
    expect(result).toHaveLength(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(result.every((e) => e.added === today)).toBe(true);
  });

  test("no-op when given empty array", () => {
    addToWatchlist([]);
    expect(existsSync(WATCHLIST_PATH)).toBe(false);
  });

  test("no-op when every tool name is invalid", () => {
    addToWatchlist(["; rm -rf /", "$(whoami)", ""]);
    expect(existsSync(WATCHLIST_PATH)).toBe(false);
  });
});
