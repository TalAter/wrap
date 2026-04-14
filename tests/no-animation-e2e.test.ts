import { describe, expect, test } from "bun:test";
import { wrapMock } from "./helpers.ts";

describe("--no-animation global flag", () => {
  test("accepted on regular prompt (not an unknown flag error)", async () => {
    const { exitCode, stderr } = await wrapMock("--no-animation hello", {
      type: "reply",
      content: "world",
      risk_level: "low",
    });
    expect(stderr).not.toContain("Unknown flag");
    expect(exitCode).toBe(0);
  });
});
