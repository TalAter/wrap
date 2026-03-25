import { afterEach, describe, expect, mock, test } from "bun:test";
import { dispatch } from "../src/subcommands/dispatch.ts";

// We test dispatch by importing it and temporarily mutating the registry.
// This avoids needing real subcommands for unit tests.
import { subcommands } from "../src/subcommands/registry.ts";
import type { Subcommand } from "../src/subcommands/types.ts";

// Capture stderr + process.exit for assertions
let stderrOutput = "";
const originalStderrWrite = process.stderr.write;
const originalExit = process.exit;

function captureStderr() {
  stderrOutput = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrOutput += String(chunk);
    return true;
  };
}

function restoreStderr() {
  process.stderr.write = originalStderrWrite;
}

afterEach(() => {
  subcommands.length = 0;
  restoreStderr();
  process.exit = originalExit;
});

function mockSubcommand(overrides: Partial<Subcommand> = {}): Subcommand {
  return {
    flag: "--test",
    description: "A test command",
    usage: "w --test",
    run: mock(async () => {}),
    ...overrides,
  };
}

describe("dispatch", () => {
  test("calls run([]) for known flag with no args", async () => {
    const cmd = mockSubcommand();
    subcommands.push(cmd);
    await dispatch("--test", []);
    expect(cmd.run).toHaveBeenCalledWith([]);
  });

  test("passes args array to run()", async () => {
    const cmd = mockSubcommand();
    subcommands.push(cmd);
    await dispatch("--test", ["5"]);
    expect(cmd.run).toHaveBeenCalledWith(["5"]);
  });

  test("passes multiple args to run()", async () => {
    const cmd = mockSubcommand();
    subcommands.push(cmd);
    await dispatch("--test", ["term", "--raw"]);
    expect(cmd.run).toHaveBeenCalledWith(["term", "--raw"]);
  });

  test("errors on unknown flag", async () => {
    captureStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--nope", []);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("Unknown flag: --nope");
  });
});
