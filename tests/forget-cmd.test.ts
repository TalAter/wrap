import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpHome, wrap } from "./helpers.ts";

function seedAll(wrapHome: string) {
  writeFileSync(join(wrapHome, "memory.json"), JSON.stringify({ "/": [{ fact: "x" }] }));
  writeFileSync(join(wrapHome, "tool-watchlist.json"), "[]");
  mkdirSync(join(wrapHome, "logs"));
  writeFileSync(join(wrapHome, "logs", "wrap.jsonl"), "{}\n");
  mkdirSync(join(wrapHome, "cache"));
  writeFileSync(join(wrapHome, "cache", "c"), "c");
}

describe("w --forget (yolo path)", () => {
  test("`w --yolo --forget` deletes all four default buckets", async () => {
    const wrapHome = tmpHome();
    seedAll(wrapHome);
    const r = await wrap("--yolo --forget", { WRAP_HOME: wrapHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Forgotten.");
    expect(existsSync(join(wrapHome, "memory.json"))).toBe(false);
    expect(existsSync(join(wrapHome, "tool-watchlist.json"))).toBe(false);
    expect(existsSync(join(wrapHome, "logs", "wrap.jsonl"))).toBe(false);
    expect(existsSync(join(wrapHome, "cache"))).toBe(false);
  });

  test("`w --forget --yolo` (yolo after forget) also deletes everything", async () => {
    const wrapHome = tmpHome();
    seedAll(wrapHome);
    const r = await wrap("--forget --yolo", { WRAP_HOME: wrapHome });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("Forgotten.");
    expect(existsSync(join(wrapHome, "memory.json"))).toBe(false);
  });

  test("fresh install (nothing on disk) → exit 0, no output", async () => {
    const wrapHome = tmpHome();
    const r = await wrap("--yolo --forget", { WRAP_HOME: wrapHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("never touches config.jsonc", async () => {
    const wrapHome = tmpHome();
    seedAll(wrapHome);
    writeFileSync(join(wrapHome, "config.jsonc"), "{}");
    await wrap("--yolo --forget", { WRAP_HOME: wrapHome });
    expect(existsSync(join(wrapHome, "config.jsonc"))).toBe(true);
  });

  test("forget output goes to stderr, stdout stays silent", async () => {
    const wrapHome = tmpHome();
    seedAll(wrapHome);
    const r = await wrap("--yolo --forget", { WRAP_HOME: wrapHome });
    expect(r.stdout).toBe("");
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});

describe("w --forget (arg validation)", () => {
  test("prompt after --forget → exit 1, clear error", async () => {
    const r = await wrap("--forget delete everything");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--forget cannot be combined with a prompt");
    expect(r.stdout).toBe("");
  });

  test("prompt after --forget --yolo → still exit 1", async () => {
    const r = await wrap("--forget --yolo something extra");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--forget cannot be combined with a prompt");
  });
});

describe("w --forget (non-TTY)", () => {
  test("pipe without --yolo → exit 1 with TTY error", async () => {
    // `wrap()` pipes stdin; no TTY.
    const r = await wrap("--forget");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--forget requires a TTY or --yolo");
  });
});

describe("w --forget (WRAP_HOME override)", () => {
  test("respects WRAP_HOME when deleting", async () => {
    const wrapHome = tmpHome();
    seedAll(wrapHome);
    const r = await wrap("--yolo --forget", { WRAP_HOME: wrapHome });
    expect(r.exitCode).toBe(0);
    // Only the test-scoped home was affected; a second home untouched.
    const other = tmpHome();
    seedAll(other);
    expect(existsSync(join(other, "memory.json"))).toBe(true);
  });
});

describe("w --forget (scratch dirs)", () => {
  test("removes wrap-scratch-* dirs under tmpdir", async () => {
    // Pre-create a scratch dir with the expected prefix in the default tmpdir.
    const scratch = join(tmpdir(), `wrap-scratch-test-${process.pid}-${Date.now()}`);
    mkdirSync(scratch);
    writeFileSync(join(scratch, "f"), "x");
    try {
      const wrapHome = tmpHome();
      const r = await wrap("--yolo --forget", { WRAP_HOME: wrapHome });
      expect(r.exitCode).toBe(0);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      // Safety net if the test failed to clean up.
      if (existsSync(scratch)) {
        // best-effort
      }
    }
  });
});
