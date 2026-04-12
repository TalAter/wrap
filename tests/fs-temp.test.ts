import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeShellCommand } from "../src/core/shell.ts";
import { createTempDir, formatTempDirSection } from "../src/fs/temp.ts";

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
