import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteCache,
  deleteLogs,
  deleteMemory,
  deleteScratch,
} from "../src/subcommands/forget-delete.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

describe("deleteMemory", () => {
  test("missing files → removed false, no errors", () => {
    expect(deleteMemory()).toEqual({ removed: false, errors: [] });
  });

  test("removes memory.json + tool-watchlist.json", () => {
    writeFileSync(join(TEST_HOME, "memory.json"), "{}");
    writeFileSync(join(TEST_HOME, "tool-watchlist.json"), "[]");
    const r = deleteMemory();
    expect(r).toEqual({ removed: true, errors: [] });
    expect(existsSync(join(TEST_HOME, "memory.json"))).toBe(false);
    expect(existsSync(join(TEST_HOME, "tool-watchlist.json"))).toBe(false);
  });

  test("removes memory.json when watchlist missing", () => {
    writeFileSync(join(TEST_HOME, "memory.json"), "{}");
    const r = deleteMemory();
    expect(r.removed).toBe(true);
    expect(r.errors).toEqual([]);
    expect(existsSync(join(TEST_HOME, "memory.json"))).toBe(false);
  });

  test("does not touch config.jsonc", () => {
    writeFileSync(join(TEST_HOME, "memory.json"), "{}");
    writeFileSync(join(TEST_HOME, "config.jsonc"), "{}");
    deleteMemory();
    expect(existsSync(join(TEST_HOME, "config.jsonc"))).toBe(true);
  });

  test("non-ENOENT unlink failure is recorded in errors", () => {
    // memory.json as a directory → unlinkSync throws EISDIR (not ENOENT).
    mkdirSync(join(TEST_HOME, "memory.json"));
    const r = deleteMemory();
    expect(r.errors).toEqual([join(TEST_HOME, "memory.json")]);
    expect(r.removed).toBe(false);
  });
});

describe("deleteLogs", () => {
  test("missing log → removed false", () => {
    expect(deleteLogs()).toEqual({ removed: false, errors: [] });
  });

  test("removes wrap.jsonl", () => {
    mkdirSync(join(TEST_HOME, "logs"));
    writeFileSync(join(TEST_HOME, "logs", "wrap.jsonl"), "{}\n");
    const r = deleteLogs();
    expect(r).toEqual({ removed: true, errors: [] });
    expect(existsSync(join(TEST_HOME, "logs", "wrap.jsonl"))).toBe(false);
  });

  test("removes trace sidecars under logs/traces/", () => {
    mkdirSync(join(TEST_HOME, "logs", "traces"), { recursive: true });
    writeFileSync(join(TEST_HOME, "logs", "wrap.jsonl"), "{}\n");
    writeFileSync(join(TEST_HOME, "logs", "traces", "abc.json"), "{}");
    writeFileSync(join(TEST_HOME, "logs", "traces", "def.json"), "{}");
    const r = deleteLogs();
    expect(r).toEqual({ removed: true, errors: [] });
    expect(existsSync(join(TEST_HOME, "logs"))).toBe(false);
  });
});

describe("deleteCache", () => {
  test("missing cache dir → removed false", () => {
    expect(deleteCache()).toEqual({ removed: false, errors: [] });
  });

  test("removes whole cache dir recursively", () => {
    mkdirSync(join(TEST_HOME, "cache"));
    mkdirSync(join(TEST_HOME, "cache", "sub"));
    writeFileSync(join(TEST_HOME, "cache", "a"), "x");
    writeFileSync(join(TEST_HOME, "cache", "sub", "b"), "y");
    const r = deleteCache();
    expect(r.removed).toBe(true);
    expect(existsSync(join(TEST_HOME, "cache"))).toBe(false);
  });

  test("cache path is a file → removed=true, cache is unlinked", () => {
    // readdirSync on a regular file throws ENOTDIR (not ENOENT), so `existed`
    // stays true; rmSync(force:true, recursive:true) unlinks the file.
    writeFileSync(join(TEST_HOME, "cache"), "oops");
    const r = deleteCache();
    expect(r.removed).toBe(true);
    expect(r.errors).toEqual([]);
    expect(existsSync(join(TEST_HOME, "cache"))).toBe(false);
  });

  test("removes symlink inside cache but not the symlink target", () => {
    const target = mkdtempSync(join(tmpdir(), "wrap-cache-target-"));
    try {
      writeFileSync(join(target, "survives.txt"), "important");
      mkdirSync(join(TEST_HOME, "cache"));
      symlinkSync(target, join(TEST_HOME, "cache", "link-to-target"));
      const r = deleteCache();
      expect(r.removed).toBe(true);
      expect(existsSync(join(TEST_HOME, "cache"))).toBe(false);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(join(target, "survives.txt"), "utf-8")).toBe("important");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("deleteScratch", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wrap-del-scratch-base-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("no matching dirs → removed false", () => {
    expect(deleteScratch(base)).toEqual({ removed: false, errors: [] });
  });

  test("nonexistent tmpBase is swallowed → empty result, no throw", () => {
    const gone = join(base, "does-not-exist");
    expect(() => deleteScratch(gone)).not.toThrow();
    expect(deleteScratch(gone)).toEqual({ removed: false, errors: [] });
  });

  test("removes every wrap-scratch-* under tmpBase", () => {
    mkdirSync(join(base, "wrap-scratch-aaa"));
    writeFileSync(join(base, "wrap-scratch-aaa", "f"), "x");
    mkdirSync(join(base, "wrap-scratch-bbb"));
    const r = deleteScratch(base);
    expect(r.removed).toBe(true);
    expect(existsSync(join(base, "wrap-scratch-aaa"))).toBe(false);
    expect(existsSync(join(base, "wrap-scratch-bbb"))).toBe(false);
  });

  test("leaves non-matching entries alone", () => {
    mkdirSync(join(base, "wrap-scratch-keep-prefix"));
    mkdirSync(join(base, "other-dir"));
    writeFileSync(join(base, "loose-file"), "x");
    deleteScratch(base);
    expect(existsSync(join(base, "other-dir"))).toBe(true);
    expect(existsSync(join(base, "loose-file"))).toBe(true);
    expect(existsSync(join(base, "wrap-scratch-keep-prefix"))).toBe(false);
  });

  test("dangling wrap-scratch- symlink: removed stays false", () => {
    // A dangling symlink in tmp can happen if a previous run was interrupted.
    // rmDir reports removed=false (the inner readdirSync throws ENOENT, so
    // `existed` is false), even though rmSync(force:true) unlinks the symlink.
    // The outer `if (r.removed)` guard must propagate that false — otherwise
    // forget would print "Forgotten." on a no-op cleanup.
    symlinkSync(join(base, "missing-target"), join(base, "wrap-scratch-dangling"));
    const r = deleteScratch(base);
    expect(r.removed).toBe(false);
    expect(r.errors).toEqual([]);
  });
});
