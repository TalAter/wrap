import { describe, expect, test } from "bun:test";
import { wrap } from "./helpers.ts";

describe("--help", () => {
  test("prints help to stdout and exits 0", async () => {
    const { exitCode, stdout, stderr } = await wrap("--help");
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("wrap");
    expect(stdout).toContain("Usage:");
  });

  test("includes all registered flags", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("--log [N]");
    expect(stdout).toContain("--log-pretty [N]");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
  });

  test("shows flag descriptions", async () => {
    const { stdout } = await wrap("--help");
    expect(stdout).toContain("Show version");
    expect(stdout).toContain("Show this help");
  });

  test("does not accept an argument", async () => {
    const { exitCode, stderr } = await wrap("--help extra");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not take an argument");
  });
});
