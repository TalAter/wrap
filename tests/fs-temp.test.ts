import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeShellCommand } from "../src/core/shell.ts";
import { createTempDir, dirStats, formatSize, formatTempDirSection } from "../src/fs/temp.ts";

describe("createTempDir", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.WRAP_TEMP_DIR;
    delete process.env.WRAP_TEMP_DIR;
  });

  afterEach(() => {
    const created = process.env.WRAP_TEMP_DIR;
    if (created) rmSync(created, { recursive: true, force: true });
    if (prev === undefined) delete process.env.WRAP_TEMP_DIR;
    else process.env.WRAP_TEMP_DIR = prev;
  });

  test("creates a dir and exports WRAP_TEMP_DIR to process.env", () => {
    const path = createTempDir();
    expect(process.env.WRAP_TEMP_DIR).toBe(path);
    expect(path.length).toBeGreaterThan(0);
    // Directory exists and is writable.
    writeFileSync(join(path, "probe.txt"), "hello");
  });

  test("each invocation gets a distinct dir", () => {
    const a = createTempDir();
    const b = createTempDir();
    expect(a).not.toBe(b);
    rmSync(a, { recursive: true, force: true });
  });

  test("executeShellCommand inherits WRAP_TEMP_DIR into the spawned shell", async () => {
    // Regression: Bun.spawn does NOT inherit process.env unless you pass
    // `env` explicitly. executeShellCommand pipes process.env through;
    // this test pins that contract so a future refactor can't silently
    // break env inheritance for the temp dir or anything else.
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      const path = createTempDir();
      const exec = await executeShellCommand('printf %s "$WRAP_TEMP_DIR"', {
        mode: "capture",
      });
      expect(exec.exitCode).toBe(0);
      expect(exec.stdout).toBe(path);
    } finally {
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
    }
  });
});

describe("formatTempDirSection", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.WRAP_TEMP_DIR;
    dir = createTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.WRAP_TEMP_DIR;
    else process.env.WRAP_TEMP_DIR = prev;
  });

  test("returns an empty-state section when nothing has been written", () => {
    const section = formatTempDirSection();
    expect(section).toContain("$WRAP_TEMP_DIR");
    expect(section).toContain("(empty)");
    // Must NOT leak the literal absolute path into the prompt.
    expect(section).not.toContain(dir);
  });

  test("lists files written since the last call", () => {
    writeFileSync(join(dir, "installer.sh"), "#!/bin/sh\necho hi\n");
    mkdirSync(join(dir, "extracted"));
    writeFileSync(join(dir, "extracted", "readme.md"), "x");
    const section = formatTempDirSection();
    expect(section).toContain("installer.sh");
    expect(section).toContain("extracted");
    expect(section).not.toContain("(empty)");
    expect(section).not.toContain(dir);
  });

  test("returns an empty-state section when WRAP_TEMP_DIR is unset", () => {
    delete process.env.WRAP_TEMP_DIR;
    const section = formatTempDirSection();
    expect(section).toContain("(empty)");
  });
});

describe("formatSize", () => {
  test("bytes under 1K → B", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1023)).toBe("1023B");
  });

  test("bytes between 1K and 1M → K (rounded)", () => {
    expect(formatSize(1024)).toBe("1K");
    expect(formatSize(4096)).toBe("4K");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024K");
  });

  test("bytes >= 1M → M (rounded)", () => {
    expect(formatSize(1024 * 1024)).toBe("1M");
    expect(formatSize(5 * 1024 * 1024)).toBe("5M");
  });
});

describe("dirStats", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wrap-dirstats-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing path → {files:0, bytes:0}", () => {
    expect(dirStats(join(dir, "nope"))).toEqual({ files: 0, bytes: 0 });
  });

  test("empty dir → {files:0, bytes:0}", () => {
    expect(dirStats(dir)).toEqual({ files: 0, bytes: 0 });
  });

  test("counts files recursively, sums bytes", () => {
    writeFileSync(join(dir, "a.txt"), "hello"); // 5
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "xyz"); // 3
    writeFileSync(join(dir, "sub", "c.bin"), Buffer.alloc(100)); // 100
    expect(dirStats(dir)).toEqual({ files: 3, bytes: 108 });
  });

  test("does not follow symlinks to dirs; counts symlink as one entry", () => {
    // symlinks are counted by lstat; size of symlink itself, not target
    const target = mkdtempSync(join(tmpdir(), "wrap-dirstats-tgt-"));
    try {
      writeFileSync(join(target, "big.bin"), Buffer.alloc(10_000));
      symlinkSync(target, join(dir, "link"));
      const stats = dirStats(dir);
      // Symlink itself = 1 file. Its size is small (path bytes), definitely < 10_000.
      expect(stats.files).toBe(1);
      expect(stats.bytes).toBeLessThan(10_000);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
