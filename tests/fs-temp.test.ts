import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeShellCommand } from "../src/core/shell.ts";
import { dirStats, ensureTempDir, formatSize, formatTempDirSection } from "../src/fs/temp.ts";

describe("ensureTempDir", () => {
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

  test("creates a dir and exports WRAP_TEMP_DIR on first call", () => {
    const path = ensureTempDir();
    expect(process.env.WRAP_TEMP_DIR).toBe(path);
    expect(existsSync(path)).toBe(true);
    writeFileSync(join(path, "probe.txt"), "hello");
  });

  test("is idempotent within a process — second call reuses the dir", () => {
    const a = ensureTempDir();
    const b = ensureTempDir();
    expect(a).toBe(b);
  });

  test("executeShellCommand creates the temp dir lazily and inherits it", async () => {
    // Bun.spawn does NOT inherit process.env unless you pass `env` explicitly.
    // This test also pins the lazy-creation contract: no dir exists before
    // the first shell exec, and the dir is created on demand.
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      expect(process.env.WRAP_TEMP_DIR).toBeUndefined();
      const exec = await executeShellCommand('printf %s "$WRAP_TEMP_DIR"', {
        mode: "capture",
      });
      expect(exec.exitCode).toBe(0);
      expect(exec.stdout.length).toBeGreaterThan(0);
      expect(exec.stdout).toBe(process.env.WRAP_TEMP_DIR as string);
      expect(existsSync(exec.stdout)).toBe(true);
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
    delete process.env.WRAP_TEMP_DIR;
    dir = ensureTempDir();
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

  test("returns an empty-state section when WRAP_TEMP_DIR is unset, without creating a dir", () => {
    delete process.env.WRAP_TEMP_DIR;
    const section = formatTempDirSection();
    expect(section).toContain("(empty)");
    // Must not have created one as a side effect — lazy creation is the whole point.
    expect(process.env.WRAP_TEMP_DIR).toBeUndefined();
  });
});

describe("lazy temp dir — end-to-end round flow", () => {
  // Simulates the real sequence across LLM rounds:
  //   round 1: prompt is assembled (empty section) → LLM returns a shell
  //   command that writes to $WRAP_TEMP_DIR → shell exec creates the dir and
  //   runs the command → round 2: prompt is reassembled and now lists the
  //   file. The lazy-creation change rewires this path; this test pins it
  //   end-to-end so a future refactor can't silently break it.
  let prevTempDir: string | undefined;
  let prevShell: string | undefined;

  beforeEach(() => {
    prevTempDir = process.env.WRAP_TEMP_DIR;
    prevShell = process.env.SHELL;
    delete process.env.WRAP_TEMP_DIR;
    process.env.SHELL = "/bin/sh";
  });

  afterEach(() => {
    const created = process.env.WRAP_TEMP_DIR;
    if (created) rmSync(created, { recursive: true, force: true });
    if (prevTempDir === undefined) delete process.env.WRAP_TEMP_DIR;
    else process.env.WRAP_TEMP_DIR = prevTempDir;
    if (prevShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = prevShell;
  });

  test("round 1 empty → shell writes a file → round 2 lists the file", async () => {
    // Round 1: nothing has run yet, env var is unset, section is empty, and
    // no directory has been created on disk.
    expect(process.env.WRAP_TEMP_DIR).toBeUndefined();
    const round1 = formatTempDirSection();
    expect(round1).toContain("(empty)");
    expect(process.env.WRAP_TEMP_DIR).toBeUndefined();

    // LLM generates a shell command that writes to $WRAP_TEMP_DIR. The
    // dir is created lazily inside executeShellCommand.
    const exec = await executeShellCommand(
      'printf %s "hello" > "$WRAP_TEMP_DIR/installer.sh"',
      { mode: "capture" },
    );
    expect(exec.exitCode).toBe(0);
    const dir = process.env.WRAP_TEMP_DIR;
    expect(dir).toBeDefined();
    expect(existsSync(join(dir as string, "installer.sh"))).toBe(true);

    // Round 2: prompt reassembled. The file written in round 1 now appears.
    const round2 = formatTempDirSection();
    expect(round2).toContain("installer.sh");
    expect(round2).not.toContain("(empty)");
    expect(round2).not.toContain(dir as string);
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
