import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheFootprint,
  formatFootprint,
  logsFootprint,
  memoryFootprint,
  scratchFootprint,
} from "../src/subcommands/forget-footprint.ts";

describe("memoryFootprint", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wrap-fp-mem-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("no files → empty", () => {
    expect(memoryFootprint(home)).toEqual({ state: "empty" });
  });

  test("populated memory.json → fact count + bytes of both files", () => {
    const mem = { "/": [{ fact: "a" }, { fact: "b" }], "/tmp": [{ fact: "c" }] };
    writeFileSync(join(home, "memory.json"), JSON.stringify(mem));
    writeFileSync(join(home, "tool-watchlist.json"), "[]");
    const fp = memoryFootprint(home);
    expect(fp.state).toBe("ok");
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(3);
    expect(fp.bytes).toBeGreaterThan(0);
  });

  test("corrupt memory.json → unreadable", () => {
    writeFileSync(join(home, "memory.json"), "{not json");
    expect(memoryFootprint(home)).toEqual({ state: "unreadable" });
  });

  test("only watchlist present → ok with 0 facts but bytes > 0", () => {
    writeFileSync(join(home, "tool-watchlist.json"), "[]");
    const fp = memoryFootprint(home);
    expect(fp.state).toBe("ok");
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(0);
    expect(fp.bytes).toBeGreaterThan(0);
  });
});

describe("logsFootprint", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wrap-fp-log-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("no log file → empty", () => {
    expect(logsFootprint(home)).toEqual({ state: "empty" });
  });

  test("empty log file → empty", () => {
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs", "wrap.jsonl"), "");
    expect(logsFootprint(home)).toEqual({ state: "empty" });
  });

  test("populated log → line count + bytes", () => {
    mkdirSync(join(home, "logs"));
    const content = `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n${JSON.stringify({ a: 3 })}\n`;
    writeFileSync(join(home, "logs", "wrap.jsonl"), content);
    const fp = logsFootprint(home);
    expect(fp.state).toBe("ok");
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(3);
    expect(fp.bytes).toBe(content.length);
  });

  test("trailing newline doesn't count as extra entry", () => {
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs", "wrap.jsonl"), "{}\n{}\n");
    const fp = logsFootprint(home);
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(2);
  });

  test("single entry without trailing newline counts as 1", () => {
    mkdirSync(join(home, "logs"));
    // Single char is needed to kill the endsWith("\n") → endsWith("") mutant:
    // longer content slices to a non-empty string that splits to the same count.
    writeFileSync(join(home, "logs", "wrap.jsonl"), "x");
    const fp = logsFootprint(home);
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(1);
  });

  test("file containing only a newline → empty", () => {
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs", "wrap.jsonl"), "\n");
    expect(logsFootprint(home)).toEqual({ state: "empty" });
  });
});

describe("cacheFootprint", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wrap-fp-cache-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("missing cache dir → empty", () => {
    expect(cacheFootprint(home)).toEqual({ state: "empty" });
  });

  test("empty cache dir → empty", () => {
    mkdirSync(join(home, "cache"));
    expect(cacheFootprint(home)).toEqual({ state: "empty" });
  });

  test("sibling files outside cache/ are ignored", () => {
    writeFileSync(join(home, "memory.json"), "xxxxx");
    expect(cacheFootprint(home)).toEqual({ state: "empty" });
  });

  test("populated cache → file count + bytes, recursive", () => {
    mkdirSync(join(home, "cache"));
    writeFileSync(join(home, "cache", "a.json"), "aa");
    mkdirSync(join(home, "cache", "sub"));
    writeFileSync(join(home, "cache", "sub", "b.json"), "bbbb");
    const fp = cacheFootprint(home);
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(2);
    expect(fp.bytes).toBe(6);
  });
});

describe("scratchFootprint", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wrap-fp-scratch-base-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("no matching dirs → empty", () => {
    expect(scratchFootprint(base)).toEqual({ state: "empty" });
  });

  test("counts wrap-scratch-* dirs and sums bytes recursively", () => {
    mkdirSync(join(base, "wrap-scratch-aaa"));
    writeFileSync(join(base, "wrap-scratch-aaa", "f"), "12345"); // 5
    mkdirSync(join(base, "wrap-scratch-bbb"));
    writeFileSync(join(base, "wrap-scratch-bbb", "f"), "xyz"); // 3
    // Non-match — must be ignored.
    mkdirSync(join(base, "wrap-other-zzz"));
    writeFileSync(join(base, "wrap-other-zzz", "f"), "zzzzzzzz");
    const fp = scratchFootprint(base);
    if (fp.state !== "ok") throw new Error();
    expect(fp.count).toBe(2);
    expect(fp.bytes).toBe(8);
  });

  test("matches prefix strictly — 'wrap-other' does not match", () => {
    mkdirSync(join(base, "wrap-other"));
    writeFileSync(join(base, "wrap-other", "f"), "zzz");
    expect(scratchFootprint(base)).toEqual({ state: "empty" });
  });

  test("nonexistent tmpBase → empty", () => {
    expect(scratchFootprint(join(base, "does-not-exist"))).toEqual({ state: "empty" });
  });

  test("regular file matching prefix is ignored", () => {
    writeFileSync(join(base, "wrap-scratch-file"), "zzzz");
    expect(scratchFootprint(base)).toEqual({ state: "empty" });
  });

  test("broken symlink matching prefix is ignored", () => {
    symlinkSync(join(base, "does-not-exist"), join(base, "wrap-scratch-broken"));
    expect(scratchFootprint(base)).toEqual({ state: "empty" });
  });
});

describe("formatFootprint", () => {
  test("empty state", () => {
    expect(formatFootprint("facts", { state: "empty" })).toBe("(empty)");
  });

  test("unreadable state", () => {
    expect(formatFootprint("facts", { state: "unreadable" })).toBe("(unreadable)");
  });

  test("ok state — facts unit", () => {
    expect(formatFootprint("facts", { state: "ok", count: 23, bytes: 4096 })).toBe(
      "(23 facts, 4K)",
    );
  });

  test("ok state — entries unit, thousands separator", () => {
    expect(formatFootprint("entries", { state: "ok", count: 1203, bytes: 4 * 1024 * 1024 })).toBe(
      "(1,203 entries, 4M)",
    );
  });

  test("ok state — singular unit", () => {
    expect(formatFootprint("files", { state: "ok", count: 1, bytes: 100 })).toBe("(1 file, 100B)");
  });

  test("ok state — entries singular", () => {
    expect(formatFootprint("entries", { state: "ok", count: 1, bytes: 10 })).toBe("(1 entry, 10B)");
  });

  test("ok state — dirs plural", () => {
    expect(formatFootprint("dirs", { state: "ok", count: 3, bytes: 0 })).toBe("(3 dirs, 0B)");
  });
});
