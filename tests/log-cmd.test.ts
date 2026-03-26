import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchEntries } from "../src/subcommands/log.ts";
import { tmpHome, wrap } from "./helpers.ts";

function seedLog(wrapHome: string, lines: string[]): string {
  const logsDir = join(wrapHome, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "wrap.jsonl");
  writeFileSync(logPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
  return logPath;
}

function entry(id: string, prompt = "test") {
  return JSON.stringify({ id, timestamp: "2026-03-23T00:00:00Z", prompt });
}

describe("--log", () => {
  test("outputs all entries as raw JSONL (piped = raw default)", async () => {
    const wrapHome = tmpHome();
    const lines = [entry("a"), entry("b"), entry("c")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${lines.join("\n")}\n`);
    expect(result.stderr).toBe("");
  });

  test("--log N outputs last N entries", async () => {
    const wrapHome = tmpHome();
    const lines = [entry("a"), entry("b"), entry("c")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log 2", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${[entry("b"), entry("c")].join("\n")}\n`);
  });

  test("--log 1 outputs last entry", async () => {
    const wrapHome = tmpHome();
    seedLog(wrapHome, [entry("a"), entry("b")]);
    const result = await wrap("--log 1", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${entry("b")}\n`);
  });

  test("--log 0 outputs nothing", async () => {
    const wrapHome = tmpHome();
    seedLog(wrapHome, [entry("a"), entry("b")]);
    const result = await wrap("--log 0", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("no log file shows message on stderr, exits 0", async () => {
    const result = await wrap("--log");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No log entries yet.");
  });

  test("skips corrupt lines with warning", async () => {
    const wrapHome = tmpHome();
    const lines = [entry("a"), "not-json", entry("c")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${[entry("a"), entry("c")].join("\n")}\n`);
    expect(result.stderr).toContain("skipped 1 corrupt");
  });

  test("N counts raw lines including corrupt ones", async () => {
    const wrapHome = tmpHome();
    // 5 raw lines, last 3 = [entry("c"), "bad", entry("e")]
    const lines = [entry("a"), entry("b"), entry("c"), "bad", entry("e")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log 3", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    // Should output entry("c") and entry("e"), skip "bad"
    expect(result.stdout).toBe(`${[entry("c"), entry("e")].join("\n")}\n`);
    expect(result.stderr).toContain("skipped 1 corrupt");
  });

  test("--raw flag outputs raw JSONL", async () => {
    const wrapHome = tmpHome();
    const lines = [entry("a"), entry("b")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log --raw", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${lines.join("\n")}\n`);
  });
});

describe("--log search", () => {
  test("search filters entries by substring", async () => {
    const wrapHome = tmpHome();
    const lines = [entry("a", "find files"), entry("b", "list docker"), entry("c", "find ports")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log find", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"find files"');
    expect(result.stdout).toContain('"find ports"');
    expect(result.stdout).not.toContain('"list docker"');
  });

  test("search is case-insensitive", async () => {
    const wrapHome = tmpHome();
    seedLog(wrapHome, [entry("a", "Find Files"), entry("b", "other")]);
    const result = await wrap("--log find", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"Find Files"');
    expect(result.stdout).not.toContain('"other"');
  });

  test("search with no matches shows message", async () => {
    const wrapHome = tmpHome();
    seedLog(wrapHome, [entry("a", "hello")]);
    const result = await wrap("--log zzzzz", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No matching log entries.");
  });

  test("search combined with N takes last N matches", async () => {
    const wrapHome = tmpHome();
    const lines = [entry("a", "find one"), entry("b", "find two"), entry("c", "find three")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log find 2", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('"find one"');
    expect(result.stdout).toContain('"find two"');
    expect(result.stdout).toContain('"find three"');
  });

  test("search with --raw outputs raw JSONL", async () => {
    const wrapHome = tmpHome();
    seedLog(wrapHome, [entry("a", "hello world"), entry("b", "other")]);
    const result = await wrap("--log hello --raw", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    // Raw = one JSON object per line, no indentation
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).prompt).toBe("hello world");
  });

  test("errors on two search terms", async () => {
    const result = await wrap("--log foo bar");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Only one search term allowed");
  });

  test("errors on negative number", async () => {
    const result = await wrap("--log -3");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-negative integer");
  });
});

describe("searchEntries", () => {
  test("matches substring in any value", () => {
    const entries = [
      { id: "a", prompt: "find files" },
      { id: "b", prompt: "list stuff" },
    ];
    expect(searchEntries(entries, "find")).toEqual([{ id: "a", prompt: "find files" }]);
  });

  test("is case-insensitive", () => {
    const entries = [{ id: "a", prompt: "Find Files" }];
    expect(searchEntries(entries, "find files")).toEqual(entries);
  });

  test("matches nested values", () => {
    const entries = [{ id: "a", nested: { command: "docker ps" } }];
    expect(searchEntries(entries, "docker")).toEqual(entries);
  });

  test("returns empty array for no matches", () => {
    const entries = [{ id: "a", prompt: "hello" }];
    expect(searchEntries(entries, "zzz")).toEqual([]);
  });

  test("returns all entries when no filtering needed", () => {
    const entries = [{ id: "a" }, { id: "b" }];
    // Both contain "id" in their JSON serialization
    expect(searchEntries(entries, "id")).toEqual(entries);
  });
});
