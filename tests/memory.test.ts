import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendFacts, loadMemory, saveMemory } from "../src/memory/memory.ts";
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

describe("appendFacts", () => {
  test("appends fact to global scope", () => {
    const dir = tempDir();
    saveMemory(dir, { "/": [{ fact: "existing" }] });
    const result = appendFacts(dir, [{ fact: "new fact", scope: "/" }], "/");
    expect(result["/"]).toEqual([{ fact: "existing" }, { fact: "new fact" }]);
    // Verify persisted
    expect(loadMemory(dir)).toEqual(result);
  });

  test("creates new scope if it doesn't exist", () => {
    const dir = tempDir();
    saveMemory(dir, { "/": [{ fact: "global" }] });
    // Use /tmp as the scope — it exists on disk
    const resolved = realpathSync("/tmp");
    const result = appendFacts(dir, [{ fact: "tmp fact", scope: "/tmp" }], "/");
    expect(result[resolved]).toEqual([{ fact: "tmp fact" }]);
    expect(result["/"]).toEqual([{ fact: "global" }]);
  });

  test("discards facts with non-existent scope paths", () => {
    const dir = tempDir();
    saveMemory(dir, { "/": [{ fact: "global" }] });
    const result = appendFacts(
      dir,
      [{ fact: "should be discarded", scope: "/nonexistent/path/xyz" }],
      "/",
    );
    expect(result).toEqual({ "/": [{ fact: "global" }] });
  });

  test("resolves relative scope paths against CWD", () => {
    const dir = tempDir();
    const cwd = realpathSync("/tmp");
    saveMemory(dir, {});
    const result = appendFacts(dir, [{ fact: "relative scope fact", scope: "." }], cwd);
    expect(result[cwd]).toEqual([{ fact: "relative scope fact" }]);
  });

  test("sorts keys in persisted file", () => {
    const dir = tempDir();
    const resolved = realpathSync("/tmp");
    saveMemory(dir, { [resolved]: [{ fact: "tmp" }] });
    appendFacts(dir, [{ fact: "global", scope: "/" }], "/");
    const raw = readFileSync(join(dir, "memory.json"), "utf-8");
    const keys = Object.keys(JSON.parse(raw));
    expect(keys[0]).toBe("/");
  });

  test("handles empty updates array", () => {
    const dir = tempDir();
    saveMemory(dir, { "/": [{ fact: "existing" }] });
    const result = appendFacts(dir, [], "/");
    expect(result).toEqual({ "/": [{ fact: "existing" }] });
  });

  test("resolves ~ scope to homedir", () => {
    const dir = tempDir();
    saveMemory(dir, {});
    const result = appendFacts(dir, [{ fact: "home fact", scope: "~" }], "/");
    const home = realpathSync(homedir());
    expect(result[home]).toEqual([{ fact: "home fact" }]);
  });

  test("discards ~ subpath that doesn't exist", () => {
    const dir = tempDir();
    saveMemory(dir, {});
    const result = appendFacts(
      dir,
      [{ fact: "should be discarded", scope: "~/nonexistent-dir-xyz" }],
      "/",
    );
    expect(Object.keys(result)).toEqual([]);
  });

  test("skips duplicate facts within the same scope", () => {
    const dir = tempDir();
    saveMemory(dir, { "/": [{ fact: "existing" }] });
    const result = appendFacts(dir, [{ fact: "existing", scope: "/" }], "/");
    expect(result["/"]).toEqual([{ fact: "existing" }]);
  });

  test("skips duplicates across a batch of updates", () => {
    const dir = tempDir();
    saveMemory(dir, {});
    const result = appendFacts(
      dir,
      [
        { fact: "same fact", scope: "/" },
        { fact: "same fact", scope: "/" },
      ],
      "/",
    );
    expect(result["/"]).toEqual([{ fact: "same fact" }]);
  });

  test("appends multiple facts to different scopes", () => {
    const dir = tempDir();
    const resolved = realpathSync("/tmp");
    saveMemory(dir, { "/": [{ fact: "global" }] });
    const result = appendFacts(
      dir,
      [
        { fact: "new global", scope: "/" },
        { fact: "tmp fact", scope: "/tmp" },
      ],
      "/",
    );
    expect(result["/"]).toEqual([{ fact: "global" }, { fact: "new global" }]);
    expect(result[resolved]).toEqual([{ fact: "tmp fact" }]);
  });
});
