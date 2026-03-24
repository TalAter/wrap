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
  test("calls run() for known flag with no arg", async () => {
    const cmd = mockSubcommand();
    subcommands.push(cmd);
    await dispatch("--test", null);
    expect(cmd.run).toHaveBeenCalledWith(null);
  });

  test("passes string arg to run()", async () => {
    const cmd = mockSubcommand({
      flag: "--greet",
      usage: "w --greet <name>",
      arg: { name: "name", type: "string", required: true },
    });
    subcommands.push(cmd);
    await dispatch("--greet", "world");
    expect(cmd.run).toHaveBeenCalledWith("world");
  });

  test("coerces and passes number arg to run()", async () => {
    const cmd = mockSubcommand({
      flag: "--log",
      usage: "w --log [N]",
      arg: { name: "N", type: "number", required: false },
    });
    subcommands.push(cmd);
    await dispatch("--log", "5");
    expect(cmd.run).toHaveBeenCalledWith(5);
  });

  test("errors on unknown flag", async () => {
    captureStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--nope", null);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("Unknown flag: --nope");
  });

  test("errors when required arg is missing", async () => {
    const cmd = mockSubcommand({
      flag: "--greet",
      usage: "w --greet <name>",
      arg: { name: "name", type: "string", required: true },
    });
    subcommands.push(cmd);
    captureStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--greet", null);
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("Missing argument");
    expect(stderrOutput).toContain("w --greet <name>");
  });

  test("errors when arg passed to no-arg flag", async () => {
    const cmd = mockSubcommand();
    subcommands.push(cmd);
    captureStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--test", "extra");
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("does not take an argument");
  });

  test("errors when number arg is not a valid number", async () => {
    const cmd = mockSubcommand({
      flag: "--log",
      usage: "w --log [N]",
      arg: { name: "N", type: "number", required: false },
    });
    subcommands.push(cmd);
    captureStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--log", "foo");
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("expects a number");
    expect(stderrOutput).toContain("w --log [N]");
  });

  test("errors when number arg is negative", async () => {
    const cmd = mockSubcommand({
      flag: "--log",
      usage: "w --log [N]",
      arg: { name: "N", type: "number", required: false },
    });
    subcommands.push(cmd);
    captureStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--log", "-3");
    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("expects a number");
  });

  test("optional arg: calls run(null) when no arg given", async () => {
    const cmd = mockSubcommand({
      flag: "--log",
      usage: "w --log [N]",
      arg: { name: "N", type: "number", required: false },
    });
    subcommands.push(cmd);
    await dispatch("--log", null);
    expect(cmd.run).toHaveBeenCalledWith(null);
  });
});
