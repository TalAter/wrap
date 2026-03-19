import { describe, expect, test } from "bun:test";
import { wrap, wrapMock } from "./helpers.ts";

describe("wrap", () => {
  test("shows usage and exits 1 with no args", async () => {
    const { exitCode, stdout, stderr } = await wrap();
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Usage: wrap <prompt>\n");
  });

  test("errors when no provider configured", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({}),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Config error: no provider configured.\n");
  });

  test("errors on unrecognized provider type", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({ provider: { type: "nonexistent" } }),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe('Config error: unrecognized provider "nonexistent".\n');
  });

  test("errors on malformed WRAP_CONFIG", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: "{broken",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Config error: WRAP_CONFIG contains invalid JSON.\n");
  });

  test("shows clean error when LLM subprocess fails", async () => {
    // claude-code provider with a model that doesn't exist triggers a subprocess error
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({
        provider: { type: "claude-code", model: "nonexistent-model-xyz" },
      }),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    // Should be a clean error message, not a stack trace
    expect(stderr).not.toContain("at ");
    expect(stderr.trim().length).toBeGreaterThan(0);
  });

  test("sends prompt to LLM and outputs result", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello world");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hello world\n");
    expect(stderr).toBe("");
  });
});
