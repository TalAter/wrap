import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executeShellCommand } from "../src/core/shell.ts";

// Pin SHELL=sh for stable behavior — zsh emits "can't change option: zle"
// warnings to stderr when invoked with -i from a non-TTY, which would
// pollute stderr capture assertions.
const originalShell = process.env.SHELL;
beforeAll(() => {
  process.env.SHELL = "/bin/sh";
});
afterAll(() => {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

describe("executeShellCommand (capture mode)", () => {
  // Note: shell warnings (e.g. "no job control in this shell" from `+m -i`
  // when there's no TTY) land in stderr too. We assert with `toContain` so
  // shell artifacts don't break the tests — the production code passes them
  // through to the LLM, which ignores them.

  test("captures stdout from a successful command", async () => {
    const result = await executeShellCommand("echo hello", { mode: "capture" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  test("captures stderr separately from stdout", async () => {
    const result = await executeShellCommand("echo out; echo err >&2", { mode: "capture" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out\n");
    // stderr also picks up "no job control" from `+m -i` under non-TTY sh,
    // so we substring-check rather than asserting full equality.
    expect(result.stderr).toContain("err\n");
  });

  test("propagates non-zero exit codes", async () => {
    const result = await executeShellCommand("exit 7", { mode: "capture" });
    expect(result.exitCode).toBe(7);
  });

  test("returns exec_ms as a non-negative integer", async () => {
    const result = await executeShellCommand("true", { mode: "capture" });
    expect(typeof result.exec_ms).toBe("number");
    expect(result.exec_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.exec_ms)).toBe(true);
  });

  test("forwards a Blob to stdin and the command can read it", async () => {
    const result = await executeShellCommand("cat", {
      mode: "capture",
      stdinBlob: new Blob(["piped input here"]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("piped input here");
  });

  test("reports the shell that was used", async () => {
    const result = await executeShellCommand("true", { mode: "capture" });
    expect(typeof result.shell).toBe("string");
    expect(result.shell.length).toBeGreaterThan(0);
  });
});

describe("executeShellCommand (inherit mode)", () => {
  test("returns the exit code without capturing output", async () => {
    // Inherit mode pipes stdio to the parent — we can still verify exit code.
    // The output goes to the test runner's stderr/stdout, which is fine; we
    // run a quiet command so it doesn't pollute test output. The InheritResult
    // type statically excludes stdout/stderr — no runtime check needed.
    const result = await executeShellCommand("true", { mode: "inherit" });
    expect(result.exitCode).toBe(0);
  });

  test("propagates non-zero exit codes in inherit mode", async () => {
    const result = await executeShellCommand("exit 3", { mode: "inherit" });
    expect(result.exitCode).toBe(3);
  });
});
