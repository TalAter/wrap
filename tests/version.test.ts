import { describe, expect, test } from "bun:test";
import { wrap } from "./helpers.ts";

describe("--version", () => {
  test("prints version to stdout and exits 0", async () => {
    const { exitCode, stdout, stderr } = await wrap("--version");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(stderr).toBe("");
  });

  test("does not accept an argument", async () => {
    const { exitCode, stderr } = await wrap("--version extra");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not take an argument");
  });
});
