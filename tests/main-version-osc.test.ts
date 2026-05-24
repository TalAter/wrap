import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as appearance from "wrap-core/theme";
import { main } from "../src/main.ts";
import { mockStdout } from "./helpers/mock-stdout.ts";

// Regression: main called resolveAppearance() before parsing argv, which
// writes "\x1b]11;?\x07" to stderr to detect dark/light theme. On slow
// TTYs (e.g. Ubuntu over SSH on AWS), the terminal's reply arrived after
// wrap exited; the parent shell echoed it on the next prompt as
// "^[]11;rgb:2828/2c2c/3434^G". --version writes plain stdout — no theme
// is needed; never probe.
describe("main --version skips OSC 11 background-color probe", () => {
  let originalArgv: string[];
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode ?? undefined;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  });

  async function runVersionAndCountProbes(flag: string): Promise<number> {
    const spy = spyOn(appearance, "resolveAppearance");
    spy.mockResolvedValue("dark");
    const stdout = mockStdout();
    process.argv = ["bun", "wrap", flag];
    let calls = 0;
    try {
      await main();
      calls = spy.mock.calls.length;
    } finally {
      stdout.restore();
      spy.mockRestore();
    }
    return calls;
  }

  test("does not call resolveAppearance for -v", async () => {
    expect(await runVersionAndCountProbes("-v")).toBe(0);
  });

  test("does not call resolveAppearance for --version", async () => {
    expect(await runVersionAndCountProbes("--version")).toBe(0);
  });
});
