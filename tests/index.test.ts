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

  test("answer: prints to stderr and exits 0", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("what is 6*7", {
      type: "answer",
      answer: "42",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("42\n");
  });

  test("answer: exits 0 with empty stderr when answer field missing", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "answer",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("errors on invalid JSON from LLM", async () => {
    const config = JSON.stringify({ provider: { type: "test" } });
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: config,
      WRAP_TEST_RESPONSE: "not json",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("invalid");
  });

  test("errors on valid JSON that fails schema validation", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "command",
      // missing risk_level (required)
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("invalid");
  });

  test("errors when command type has no command field", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "command",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("no command");
  });

  test("errors when command type has empty string command", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "command",
      command: "",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("no command");
  });

  test("command low: executes and passes stdout through", async () => {
    const { exitCode, stdout } = await wrapMock("list files", {
      type: "command",
      command: "echo hello",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hello\n");
  });

  test("command low: propagates non-zero exit code", async () => {
    const { exitCode } = await wrapMock("fail please", {
      type: "command",
      command: "exit 42",
      risk_level: "low",
    });
    expect(exitCode).toBe(42);
  });

  test("command low: passes stderr through", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("warn me", {
      type: "command",
      command: "echo warning >&2",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("warning");
  });

  test("command medium: prints command to stderr and exits 1", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("delete stuff", {
      type: "command",
      command: "rm -rf /tmp/foo",
      risk_level: "medium",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("rm -rf /tmp/foo");
  });

  test("command high: prints command to stderr and exits 1", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("nuke it", {
      type: "command",
      command: "dd if=/dev/zero of=/dev/sda",
      risk_level: "high",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("dd if=/dev/zero of=/dev/sda");
  });

  test("command medium: does not execute the command", async () => {
    const marker = `/tmp/wrap-test-${Date.now()}`;
    const { exitCode } = await wrapMock("touch file", {
      type: "command",
      command: `touch ${marker}`,
      risk_level: "medium",
    });
    expect(exitCode).toBe(1);
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });

  test("probe: errors with not-yet-supported message", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("check shell", {
      type: "probe",
      command: "echo $SHELL",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("not yet supported");
  });
});
