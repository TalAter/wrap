import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, loadMemory, saveMemory } from "../src/memory/memory.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wrap-memory-test-"));
}

describe("loadMemory", () => {
  test("returns empty array when file doesn't exist", () => {
    const result = loadMemory(tempDir());
    expect(result).toEqual([]);
  });

  test("returns parsed entries from valid file", () => {
    const dir = tempDir();
    const entries = [{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }];
    writeFileSync(join(dir, "memory.json"), JSON.stringify(entries));
    const result = loadMemory(dir);
    expect(result).toEqual(entries);
  });

  test("throws on corrupt JSON", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), "{ broken json");
    expect(() => loadMemory(dir)).toThrow("Memory error:");
  });

  test("throws on valid JSON that is not an array", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), '{"fact": "not an array"}');
    expect(() => loadMemory(dir)).toThrow("Memory error:");
  });

  test("returns empty array from empty JSON array", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "memory.json"), "[]");
    const result = loadMemory(dir);
    expect(result).toEqual([]);
  });
});

describe("saveMemory", () => {
  test("writes valid JSON", () => {
    const dir = tempDir();
    const entries = [{ fact: "Runs macOS on arm64" }];
    saveMemory(dir, entries);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(entries);
  });

  test("creates directory lazily when it doesn't exist", () => {
    const dir = join(tempDir(), "nested", "wrap");
    const entries = [{ fact: "Has git installed" }];
    saveMemory(dir, entries);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(entries);
  });

  test("overwrites existing file", () => {
    const dir = tempDir();
    saveMemory(dir, [{ fact: "old fact" }]);
    saveMemory(dir, [{ fact: "new fact" }]);
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual([{ fact: "new fact" }]);
  });
});

describe("appendMemory", () => {
  test("appends to existing entries", () => {
    const dir = tempDir();
    saveMemory(dir, [{ fact: "fact 1" }]);
    appendMemory(dir, [{ fact: "fact 2" }]);
    const result = loadMemory(dir);
    expect(result).toEqual([{ fact: "fact 1" }, { fact: "fact 2" }]);
  });

  test("creates file when none exists", () => {
    const dir = tempDir();
    appendMemory(dir, [{ fact: "first fact" }]);
    const result = loadMemory(dir);
    expect(result).toEqual([{ fact: "first fact" }]);
  });

  test("handles empty new entries (no-op write)", () => {
    const dir = tempDir();
    saveMemory(dir, [{ fact: "existing" }]);
    appendMemory(dir, []);
    const result = loadMemory(dir);
    expect(result).toEqual([{ fact: "existing" }]);
  });
});
