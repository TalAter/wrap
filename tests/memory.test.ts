import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFacts, loadMemory, saveMemory } from "../src/memory/memory.ts";
import type { Memory } from "../src/memory/types.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const MEMORY_PATH = join(TEST_HOME, "memory.json");

beforeEach(() => {
  rmSync(MEMORY_PATH, { force: true });
});

afterEach(() => {
  rmSync(MEMORY_PATH, { force: true });
});

describe("loadMemory", () => {
  test("returns empty map when file doesn't exist", () => {
    expect(loadMemory()).toEqual({});
  });

  test("returns parsed memory from valid file", () => {
    const memory: Memory = {
      "/": [{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }],
    };
    writeFileSync(MEMORY_PATH, JSON.stringify(memory));
    expect(loadMemory()).toEqual(memory);
  });

  test("parses multiple scopes", () => {
    const memory: Memory = {
      "/": [{ fact: "macOS" }],
      "/Users/tal/project": [{ fact: "Uses bun" }],
    };
    writeFileSync(MEMORY_PATH, JSON.stringify(memory));
    expect(loadMemory()).toEqual(memory);
  });

  test("throws on corrupt JSON", () => {
    writeFileSync(MEMORY_PATH, "{ broken json");
    expect(() => loadMemory()).toThrow("Memory error:");
    expect(() => loadMemory()).toThrow("broken");
  });

  test("throws on old array format", () => {
    writeFileSync(MEMORY_PATH, '[{"fact": "old format"}]');
    expect(() => loadMemory()).toThrow("Memory error:");
    expect(() => loadMemory()).toThrow("broken");
  });

  test("throws on invalid shape (string values instead of Fact arrays)", () => {
    writeFileSync(MEMORY_PATH, '{"/" : "not an array"}');
    expect(() => loadMemory()).toThrow("Memory error:");
  });

  test("returns empty map from empty JSON object", () => {
    writeFileSync(MEMORY_PATH, "{}");
    expect(loadMemory()).toEqual({});
  });

  test("error message includes path via prettyPath", () => {
    writeFileSync(MEMORY_PATH, "corrupt");
    try {
      loadMemory();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("memory.json");
      expect((e as Error).message).toContain("delete the file");
    }
  });
});

describe("saveMemory", () => {
  test("writes valid JSON", () => {
    const memory: Memory = { "/": [{ fact: "Runs macOS on arm64" }] };
    saveMemory(memory);
    expect(JSON.parse(readFileSync(MEMORY_PATH, "utf-8"))).toEqual(memory);
  });

  test("overwrites existing file", () => {
    saveMemory({ "/": [{ fact: "old fact" }] });
    saveMemory({ "/": [{ fact: "new fact" }] });
    expect(JSON.parse(readFileSync(MEMORY_PATH, "utf-8"))).toEqual({
      "/": [{ fact: "new fact" }],
    });
  });

  test("sorts keys alphabetically on write", () => {
    const memory: Memory = {
      "/Users/tal/project": [{ fact: "Uses bun" }],
      "/": [{ fact: "macOS" }],
      "/Users/tal/monorepo": [{ fact: "Uses pnpm" }],
    };
    saveMemory(memory);
    const keys = Object.keys(JSON.parse(readFileSync(MEMORY_PATH, "utf-8")));
    expect(keys).toEqual(["/", "/Users/tal/monorepo", "/Users/tal/project"]);
  });

  test("preserves fact order within each scope", () => {
    const memory: Memory = {
      "/": [{ fact: "first" }, { fact: "second" }, { fact: "third" }],
    };
    saveMemory(memory);
    const parsed = JSON.parse(readFileSync(MEMORY_PATH, "utf-8"));
    expect(parsed["/"].map((f: { fact: string }) => f.fact)).toEqual(["first", "second", "third"]);
  });
});

describe("appendFacts", () => {
  test("appends fact to global scope", () => {
    saveMemory({ "/": [{ fact: "existing" }] });
    const result = appendFacts([{ fact: "new fact", scope: "/" }], "/");
    expect(result["/"]).toEqual([{ fact: "existing" }, { fact: "new fact" }]);
    expect(loadMemory()).toEqual(result);
  });

  test("creates new scope if it doesn't exist", () => {
    saveMemory({ "/": [{ fact: "global" }] });
    const resolved = realpathSync("/tmp");
    const result = appendFacts([{ fact: "tmp fact", scope: "/tmp" }], "/");
    expect(result[resolved]).toEqual([{ fact: "tmp fact" }]);
    expect(result["/"]).toEqual([{ fact: "global" }]);
  });

  test("discards facts with non-existent scope paths", () => {
    saveMemory({ "/": [{ fact: "global" }] });
    const result = appendFacts(
      [{ fact: "should be discarded", scope: "/nonexistent/path/xyz" }],
      "/",
    );
    expect(result).toEqual({ "/": [{ fact: "global" }] });
  });

  test("resolves relative scope paths against CWD", () => {
    const cwd = realpathSync("/tmp");
    saveMemory({});
    const result = appendFacts([{ fact: "relative scope fact", scope: "." }], cwd);
    expect(result[cwd]).toEqual([{ fact: "relative scope fact" }]);
  });

  test("sorts keys in persisted file", () => {
    const resolved = realpathSync("/tmp");
    saveMemory({ [resolved]: [{ fact: "tmp" }] });
    appendFacts([{ fact: "global", scope: "/" }], "/");
    const keys = Object.keys(JSON.parse(readFileSync(MEMORY_PATH, "utf-8")));
    expect(keys[0]).toBe("/");
  });

  test("handles empty updates array", () => {
    saveMemory({ "/": [{ fact: "existing" }] });
    const result = appendFacts([], "/");
    expect(result).toEqual({ "/": [{ fact: "existing" }] });
  });

  test("resolves ~ scope to homedir", () => {
    saveMemory({});
    const result = appendFacts([{ fact: "home fact", scope: "~" }], "/");
    const home = realpathSync(homedir());
    expect(result[home]).toEqual([{ fact: "home fact" }]);
  });

  test("discards ~ subpath that doesn't exist", () => {
    saveMemory({});
    const result = appendFacts(
      [{ fact: "should be discarded", scope: "~/nonexistent-dir-xyz" }],
      "/",
    );
    expect(Object.keys(result)).toEqual([]);
  });

  test("skips duplicate facts within the same scope", () => {
    saveMemory({ "/": [{ fact: "existing" }] });
    const result = appendFacts([{ fact: "existing", scope: "/" }], "/");
    expect(result["/"]).toEqual([{ fact: "existing" }]);
  });

  test("skips duplicates across a batch of updates", () => {
    saveMemory({});
    const result = appendFacts(
      [
        { fact: "same fact", scope: "/" },
        { fact: "same fact", scope: "/" },
      ],
      "/",
    );
    expect(result["/"]).toEqual([{ fact: "same fact" }]);
  });

  test("appends multiple facts to different scopes", () => {
    const resolved = realpathSync("/tmp");
    saveMemory({ "/": [{ fact: "global" }] });
    const result = appendFacts(
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
