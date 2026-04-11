import { afterEach, describe, expect, mock, test } from "bun:test";
import { dispatch } from "../src/subcommands/dispatch.ts";
// We test dispatch by importing it and temporarily mutating the registry.
// This avoids needing real subcommands for unit tests.
import { commands } from "../src/subcommands/registry.ts";
import type { Command } from "../src/subcommands/types.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

const originalExit = process.exit;
let stderr: MockStderr | null = null;

afterEach(() => {
  commands.length = 0;
  stderr?.restore();
  stderr = null;
  process.exit = originalExit;
});

function mockCommand(overrides: Partial<Command> = {}): Command {
  return {
    kind: "command",
    flag: "--test",
    id: "test",
    description: "A test command",
    usage: "w --test",
    run: mock(async () => {}),
    ...overrides,
  };
}

describe("dispatch", () => {
  test("calls run([]) for known flag with no args", async () => {
    const cmd = mockCommand();
    commands.push(cmd);
    await dispatch("--test", []);
    expect(cmd.run).toHaveBeenCalledWith([]);
  });

  test("passes args array to run()", async () => {
    const cmd = mockCommand();
    commands.push(cmd);
    await dispatch("--test", ["5"]);
    expect(cmd.run).toHaveBeenCalledWith(["5"]);
  });

  test("passes multiple args to run()", async () => {
    const cmd = mockCommand();
    commands.push(cmd);
    await dispatch("--test", ["term", "--raw"]);
    expect(cmd.run).toHaveBeenCalledWith(["term", "--raw"]);
  });

  test("resolves alias to subcommand", async () => {
    const cmd = mockCommand({ aliases: ["-t"] });
    commands.push(cmd);
    await dispatch("-t", ["arg"]);
    expect(cmd.run).toHaveBeenCalledWith(["arg"]);
  });

  test("errors on unknown flag", async () => {
    stderr = mockStderr();
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    await dispatch("--nope", []);
    expect(exitCode).toBe(1);
    expect(stderr.text).toContain("Unknown flag: --nope");
  });
});
