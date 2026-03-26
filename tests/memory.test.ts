import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory, saveMemory } from "../src/memory/memory.ts";
import type { Memory } from "../src/memory/types.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wrap-memory-test-"));
}

describe("loadMemory", () => {
  test("returns empty map when file doesn't exist", () => {
    const result = loadMemory(tempDir());
    expect(result).toEqual({});
  });

  test("returns parsed memory from valid file", () => {
    const dir = tempDir();
    const memory: Memory = {
      "/": [{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }],
    };
    writeFileSync(join(dir, "memory.json"), JSON.stringify(memory));
    const result = loadMemory(dir);
    expect(result).toEqual(memory);
  });

  test("parses multiple scopes", () => {
    const dir = tempDir();
    const memory: Memory = {
      "/": [{ fact: "macOS" }],
      "/Users/tal/project": [{ fact: "Uses bun" }],
    };
    writeFileSync(join(dir, "memory.json"), JSON.stringify(memory));
    const result = loadMemory(dir);
    expect(result).toEqual(memory);
  });

  test("throws on corrupt JSON", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), "{ broken json");
    expect(() => loadMemory(dir)).toThrow("Memory error:");
    expect(() => loadMemory(dir)).toThrow("broken");
  });

  test("throws on old array format", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), '[{"fact": "old format"}]');
    expect(() => loadMemory(dir)).toThrow("Memory error:");
    expect(() => loadMemory(dir)).toThrow("broken");
  });

  test("throws on invalid shape (string values instead of Fact arrays)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), '{"/" : "not an array"}');
    expect(() => loadMemory(dir)).toThrow("Memory error:");
  });

  test("returns empty map from empty JSON object", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), "{}");
    const result = loadMemory(dir);
    expect(result).toEqual({});
  });

  test("error message includes path via prettyPath", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), "corrupt");
    try {
      loadMemory(dir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("memory.json");
      expect((e as Error).message).toContain("delete the file");
    }
  });
});

describe("saveMemory", () => {
  test("writes valid JSON", () => {
    const dir = tempDir();
    const memory: Memory = { "/": [{ fact: "Runs macOS on arm64" }] };
    saveMemory(dir, memory);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(memory);
  });

  test("creates directory lazily when it doesn't exist", () => {
    const dir = join(tempDir(), "nested", "wrap");
    const memory: Memory = { "/": [{ fact: "Has git installed" }] };
    saveMemory(dir, memory);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(memory);
  });

  test("overwrites existing file", () => {
    const dir = tempDir();
    saveMemory(dir, { "/": [{ fact: "old fact" }] });
    saveMemory(dir, { "/": [{ fact: "new fact" }] });
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ "/": [{ fact: "new fact" }] });
  });

  test("sorts keys alphabetically on write", () => {
    const dir = tempDir();
    const memory: Memory = {
      "/Users/tal/project": [{ fact: "Uses bun" }],
      "/": [{ fact: "macOS" }],
      "/Users/tal/monorepo": [{ fact: "Uses pnpm" }],
    };
    saveMemory(dir, memory);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    const keys = Object.keys(JSON.parse(raw));
    expect(keys).toEqual(["/", "/Users/tal/monorepo", "/Users/tal/project"]);
  });

  test("preserves fact order within each scope", () => {
    const dir = tempDir();
    const memory: Memory = {
      "/": [{ fact: "first" }, { fact: "second" }, { fact: "third" }],
    };
    saveMemory(dir, memory);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["/"].map((f: { fact: string }) => f.fact)).toEqual(["first", "second", "third"]);
  });
});
