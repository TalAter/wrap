import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToWatchlist, loadWatchlist, type WatchlistEntry } from "../src/discovery/watchlist.ts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `wrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function tmp(): string {
  const dir = makeTmpDir();
  tmpDirs.push(dir);
  return dir;
}

describe("loadWatchlist", () => {
  test("returns empty array when file does not exist", () => {
    const result = loadWatchlist(tmp());
    expect(result).toEqual([]);
  });

  test("returns empty array when file is empty", () => {
    const dir = tmp();
    writeFileSync(join(dir, "tool-watchlist.json"), "");
    expect(loadWatchlist(dir)).toEqual([]);
  });

  test("loads valid watchlist entries", () => {
    const dir = tmp();
    const entries: WatchlistEntry[] = [
      { tool: "sips", added: "2026-03-21" },
      { tool: "convert", added: "2026-03-21" },
    ];
    writeFileSync(join(dir, "tool-watchlist.json"), JSON.stringify(entries));
    const result = loadWatchlist(dir);
    expect(result).toEqual(entries);
  });

  test("filters out entries with invalid tool names", () => {
    const dir = tmp();
    const entries = [
      { tool: "sips", added: "2026-03-21" },
      { tool: "; rm -rf /", added: "2026-03-21" },
      { tool: "convert", added: "2026-03-21" },
    ];
    writeFileSync(join(dir, "tool-watchlist.json"), JSON.stringify(entries));
    const result = loadWatchlist(dir);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.tool)).toEqual(["sips", "convert"]);
  });

  test("returns empty array on malformed JSON", () => {
    const dir = tmp();
    writeFileSync(join(dir, "tool-watchlist.json"), "not json{{{");
    expect(loadWatchlist(dir)).toEqual([]);
  });

  test("returns empty array when file contains non-array JSON", () => {
    const dir = tmp();
    writeFileSync(join(dir, "tool-watchlist.json"), '{"tool": "sips"}');
    expect(loadWatchlist(dir)).toEqual([]);
  });
});

describe("addToWatchlist", () => {
  test("creates file with new entries when it does not exist", () => {
    const dir = tmp();
    addToWatchlist(dir, ["sips", "convert"]);
    const result = loadWatchlist(dir);
    expect(result).toHaveLength(2);
    expect(result[0]?.tool).toBe("sips");
    expect(result[1]?.tool).toBe("convert");
  });

  test("entries have ISO date added field", () => {
    const dir = tmp();
    addToWatchlist(dir, ["sips"]);
    const result = loadWatchlist(dir);
    expect(result[0]?.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("re-nomination updates the date", () => {
    const dir = tmp();
    const existing: WatchlistEntry[] = [{ tool: "sips", added: "2025-01-01" }];
    writeFileSync(join(dir, "tool-watchlist.json"), JSON.stringify(existing));

    addToWatchlist(dir, ["sips", "convert"]);
    const result = loadWatchlist(dir);
    expect(result).toHaveLength(2);
    // sips date updated to today (not the original 2025-01-01)
    const today = new Date().toISOString().slice(0, 10);
    expect(result.find((e) => e.tool === "sips")?.added).toBe(today);
    // convert also gets today
    expect(result.find((e) => e.tool === "convert")?.added).toBe(today);
  });

  test("silently drops invalid tool names", () => {
    const dir = tmp();
    addToWatchlist(dir, ["valid-tool", "; rm -rf /", "$(whoami)", ""]);
    const result = loadWatchlist(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBe("valid-tool");
  });

  test("re-nominating all tools updates their dates", () => {
    const dir = tmp();
    const existing: WatchlistEntry[] = [
      { tool: "sips", added: "2025-01-01" },
      { tool: "convert", added: "2025-01-01" },
    ];
    writeFileSync(join(dir, "tool-watchlist.json"), JSON.stringify(existing));

    addToWatchlist(dir, ["sips", "convert"]);
    const result = loadWatchlist(dir);
    expect(result).toHaveLength(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(result.every((e) => e.added === today)).toBe(true);
  });

  test("no-op when given empty array", () => {
    const dir = tmp();
    addToWatchlist(dir, []);
    expect(existsSync(join(dir, "tool-watchlist.json"))).toBe(false);
  });
});
