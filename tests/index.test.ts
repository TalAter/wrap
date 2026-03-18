import { describe, expect, test } from "bun:test";
import { wrap } from "./helpers.ts";

describe("wrap", () => {
  test("outputs version to stderr, nothing to stdout", async () => {
    const { exitCode, stdout, stderr } = await wrap("w");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("wrap v0.0.1");
    expect(stdout).toBe("");
  });
});
