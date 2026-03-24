import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrap } from "./helpers.ts";

function seedLog(wrapHome: string, lines: string[]): string {
  const logsDir = join(wrapHome, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "wrap.jsonl");
  writeFileSync(logPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
  return logPath;
}

function entry(id: string) {
  return JSON.stringify({ id, timestamp: "2026-03-23T00:00:00Z", prompt: "test" });
}

describe("--log", () => {
  test("outputs all entries as raw JSONL", async () => {
    const { wrapHome } = await wrap("--log");
    const lines = [entry("a"), entry("b"), entry("c")];
    seedLog(wrapHome, lines);
    const result = await wrap("--log", { WRAP_HOME: wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${lines.join("\n")}\n`);
    expect(result.stderr).toBe("");
  });

  test("--log N outputs last N entries", async () => {
    const result1 = await wrap("--log");
    const lines = [entry("a"), entry("b"), entry("c")];
    seedLog(result1.wrapHome, lines);
    const result = await wrap("--log 2", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${[entry("b"), entry("c")].join("\n")}\n`);
  });

  test("--log 1 outputs last entry", async () => {
    const result1 = await wrap("--log");
    seedLog(result1.wrapHome, [entry("a"), entry("b")]);
    const result = await wrap("--log 1", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${entry("b")}\n`);
  });

  test("--log 0 outputs nothing", async () => {
    const result1 = await wrap("--log");
    seedLog(result1.wrapHome, [entry("a"), entry("b")]);
    const result = await wrap("--log 0", { WRAP_HOME: result1.wrapHome });
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

  test("invalid arg shows error", async () => {
    const result = await wrap("--log foo");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expects a number");
  });

  test("skips corrupt lines with warning", async () => {
    const result1 = await wrap("--log");
    const lines = [entry("a"), "not-json", entry("c")];
    seedLog(result1.wrapHome, lines);
    const result = await wrap("--log", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${[entry("a"), entry("c")].join("\n")}\n`);
    expect(result.stderr).toContain("skipped 1 corrupt");
  });

  test("N counts raw lines including corrupt ones", async () => {
    const result1 = await wrap("--log");
    // 5 raw lines, last 3 = [entry("c"), "bad", entry("e")]
    const lines = [entry("a"), entry("b"), entry("c"), "bad", entry("e")];
    seedLog(result1.wrapHome, lines);
    const result = await wrap("--log 3", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    // Should output entry("c") and entry("e"), skip "bad"
    expect(result.stdout).toBe(`${[entry("c"), entry("e")].join("\n")}\n`);
    expect(result.stderr).toContain("skipped 1 corrupt");
  });
});

describe("--log-pretty", () => {
  test("outputs indented JSON", async () => {
    const result1 = await wrap("--log-pretty");
    const obj = { id: "a", timestamp: "2026-03-23T00:00:00Z", prompt: "test" };
    seedLog(result1.wrapHome, [JSON.stringify(obj)]);
    const result = await wrap("--log-pretty", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(JSON.stringify(obj, null, 2));
  });

  test("separates entries with blank line", async () => {
    const result1 = await wrap("--log-pretty");
    const objs = [
      { id: "a", timestamp: "2026-03-23T00:00:00Z", prompt: "test1" },
      { id: "b", timestamp: "2026-03-23T00:00:00Z", prompt: "test2" },
    ];
    seedLog(
      result1.wrapHome,
      objs.map((o) => JSON.stringify(o)),
    );
    const result = await wrap("--log-pretty", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    const expected = `${objs.map((o) => JSON.stringify(o, null, 2)).join("\n\n")}\n`;
    expect(result.stdout).toBe(expected);
  });

  test("--log-pretty N outputs last N entries formatted", async () => {
    const result1 = await wrap("--log-pretty");
    const objs = [
      { id: "a", timestamp: "2026-03-23T00:00:00Z", prompt: "test1" },
      { id: "b", timestamp: "2026-03-23T00:00:00Z", prompt: "test2" },
    ];
    seedLog(
      result1.wrapHome,
      objs.map((o) => JSON.stringify(o)),
    );
    const result = await wrap("--log-pretty 1", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(objs[1], null, 2)}\n`);
  });

  test("no log file shows message on stderr, exits 0", async () => {
    const result = await wrap("--log-pretty");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No log entries yet.");
  });

  test("skips corrupt lines with warning", async () => {
    const result1 = await wrap("--log-pretty");
    const obj = { id: "a", timestamp: "2026-03-23T00:00:00Z", prompt: "test" };
    seedLog(result1.wrapHome, [JSON.stringify(obj), "corrupt"]);
    const result = await wrap("--log-pretty", { WRAP_HOME: result1.wrapHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(JSON.stringify(obj, null, 2));
    expect(result.stderr).toContain("skipped 1 corrupt");
  });
});
