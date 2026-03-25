import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wrap, wrapMock } from "./helpers.ts";

describe("wrap", () => {
  test("shows help and exits 0 with no args", async () => {
    const { exitCode, stdout, stderr } = await wrap();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stderr).toBe("");
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

  test("answer: prints to stdout and exits 0", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("what is 6*7", {
      type: "answer",
      content: "42",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("42\n");
    expect(stderr).toBe("");
  });

  test("errors when content is empty string (answer)", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "answer",
      content: "",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("empty response");
  });

  test("errors when content is empty string (command)", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "command",
      content: "",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("empty response");
  });

  test("errors when content is whitespace-only", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "answer",
      content: "   ",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("empty response");
  });

  test("errors on invalid JSON from LLM", async () => {
    const config = JSON.stringify({ provider: { type: "test" } });
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: config,
      WRAP_TEST_RESPONSE: "not json",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.toLowerCase()).toMatch(/json|parse/);
  });

  test("errors on valid JSON that fails schema validation", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("hello", {
      type: "command",
      // missing risk_level (required)
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim().length).toBeGreaterThan(0);
  });

  test("command low: executes and passes stdout through", async () => {
    const { exitCode, stdout } = await wrapMock("list files", {
      type: "command",
      content: "echo hello",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hello\n");
  });

  test("command low: propagates non-zero exit code", async () => {
    const { exitCode } = await wrapMock("fail please", {
      type: "command",
      content: "exit 42",
      risk_level: "low",
    });
    expect(exitCode).toBe(42);
  });

  test("command low: passes stderr through", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("warn me", {
      type: "command",
      content: "echo warning >&2",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("warning");
  });

  test("command medium: prints command to stderr and exits 1", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("delete stuff", {
      type: "command",
      content: "rm -rf /tmp/foo",
      risk_level: "medium",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("rm -rf /tmp/foo");
  });

  test("command high: prints command to stderr and exits 1", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("nuke it", {
      type: "command",
      content: "dd if=/dev/zero of=/dev/sda",
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
      content: `touch ${marker}`,
      risk_level: "medium",
    });
    expect(exitCode).toBe(1);
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });

  test("probe: errors with not-yet-supported message", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("check shell", {
      type: "probe",
      content: "echo $SHELL",
      risk_level: "low",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("not yet supported");
  });

  test("e2e: first run inits memory, then query succeeds", async () => {
    const config = JSON.stringify({ provider: { type: "test" } });
    const response = JSON.stringify({ type: "command", content: "echo hi", risk_level: "low" });
    const { exitCode, stdout, stderr, wrapHome } = await wrap("say hi", {
      WRAP_CONFIG: config,
      WRAP_TEST_RESPONSE: response,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hi\n");
    expect(stderr).toContain("Learning about your system");
    expect(stderr).toContain("Detected");
    const memoryPath = join(wrapHome, "memory.json");
    expect(existsSync(memoryPath)).toBe(true);
    const memory = JSON.parse(readFileSync(memoryPath, "utf-8"));
    expect(Array.isArray(memory)).toBe(true);
    expect(memory.length).toBeGreaterThan(0);
    expect(memory[0]).toHaveProperty("fact");
  });

  test("memory_updates: shown on stderr", async () => {
    const { exitCode, stderr } = await wrapMock("list files", {
      type: "command",
      content: "echo hi",
      risk_level: "low",
      memory_updates: [{ fact: "Uses zsh" }],
      memory_updates_message: "Noted: you use zsh",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Noted: you use zsh");
  });
});
