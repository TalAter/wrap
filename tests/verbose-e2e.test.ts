import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpHome, wrap, wrapMock } from "./helpers.ts";

/** Like wrapMock but prepends --verbose to the prompt args. */
async function wrapVerbose(
  prompt: string,
  response: object | object[],
  config?: Record<string, unknown>,
) {
  const wrapHome = tmpHome();
  writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');
  const env: Record<string, string> = {
    WRAP_HOME: wrapHome,
    WRAP_CONFIG: JSON.stringify(config ?? {}),
  };
  if (Array.isArray(response)) {
    env.WRAP_TEST_RESPONSES = JSON.stringify(response);
  } else {
    env.WRAP_TEST_RESPONSE = JSON.stringify(response);
  }
  return wrap(`--verbose ${prompt}`, env);
}

describe("verbose e2e", () => {
  test("--verbose answer: shows all standard lines and passes output", async () => {
    const { exitCode, stdout, stderr } = await wrapVerbose("hello", {
      type: "reply",
      content: "world",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("world\n");
    expect(stderr).toContain("Config loaded (test / test)");
    expect(stderr).toContain("Provider initialized (test / test)");
    expect(stderr).toMatch(/Tools: \d+\/\d+ available/);
    expect(stderr).toMatch(/Memory: \d+ facts/);
    expect(stderr).toContain("Calling test / test...");
    expect(stderr).toContain("LLM responded (reply, 5 chars)");
    // All verbose lines have elapsed timestamps
    const verboseLines = stderr.split("\n").filter((l) => l.includes("»"));
    expect(verboseLines.length).toBeGreaterThan(0);
    for (const line of verboseLines) {
      expect(line).toMatch(/\[\+\d+\.\d{2}s\]/);
    }
  });

  test("--verbose command: shows response, execution, and passes output", async () => {
    const { exitCode, stdout, stderr } = await wrapVerbose("list files", {
      type: "command",
      content: "echo hello",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hello\n");
    expect(stderr).toContain("LLM responded (command, low):");
    expect(stderr).toContain("echo hello");
    expect(stderr).toContain("Running: echo hello");
    expect(stderr).toContain("Command exited (0)");
  });

  test("--verbose shows step execution", async () => {
    const { stderr } = await wrapVerbose("find tools", [
      {
        type: "command",
        final: false,
        content: "echo sips",
        risk_level: "low",
        explanation: "Checking tools",
      },
      { type: "command", content: "echo done", risk_level: "low" },
    ]);
    expect(stderr).toContain("LLM responded (step, low):");
    expect(stderr).toContain("echo sips");
    expect(stderr).toContain("Step: echo sips");
    expect(stderr).toContain("Step exited (0)");
    expect(stderr).toContain("Round 2/");
  });

  test("--verbose with memory updates shows update line", async () => {
    const { stderr } = await wrapVerbose("list files", {
      type: "command",
      content: "echo hi",
      risk_level: "low",
      memory_updates: [{ fact: "Uses zsh", scope: "/" }],
      memory_updates_message: "Noted: you use zsh",
    });
    expect(stderr).toContain("Memory updated: 1 facts");
  });

  test("--verbose with watchlist additions shows watchlist line", async () => {
    const { stderr } = await wrapVerbose("convert image", {
      type: "command",
      content: "echo done",
      risk_level: "low",
      watchlist_additions: ["sips", "magick"],
    });
    expect(stderr).toContain("Watchlist: added sips, magick");
  });

  test("without --verbose flag, no verbose output", async () => {
    const { stderr } = await wrapMock("hello", {
      type: "reply",
      content: "world",
      risk_level: "low",
    });
    expect(stderr).not.toContain("»");
    expect(stderr).not.toContain("Config loaded");
  });

  test("--verbose with no prompt shows help (no verbose output)", async () => {
    const { exitCode, stdout, stderr } = await wrap("--verbose");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    // Verbose doesn't activate because config hasn't loaded
    expect(stderr).not.toContain("Config loaded");
  });

  test("verbose via config key works", async () => {
    const wrapHome = tmpHome();
    writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');
    const { stderr } = await wrap("hello", {
      WRAP_HOME: wrapHome,
      WRAP_CONFIG: JSON.stringify({ verbose: true }),
      WRAP_TEST_RESPONSE: JSON.stringify({
        type: "reply",
        content: "world",
        risk_level: "low",
      }),
    });
    expect(stderr).toContain("Config loaded (test / test)");
    expect(stderr).toContain("Calling test / test...");
  });

  test("--verbose shows command exit code for non-zero", async () => {
    const { stderr } = await wrapVerbose("fail", {
      type: "command",
      content: "exit 42",
      risk_level: "low",
    });
    expect(stderr).toContain("Command exited (42)");
  });

  test("--verbose shows init sub-steps on first run", async () => {
    const wrapHome = tmpHome();
    // No memory.json — triggers init
    const { stderr } = await wrap("--verbose hello", {
      WRAP_HOME: wrapHome,
      WRAP_CONFIG: JSON.stringify({}),
      WRAP_TEST_RESPONSE: JSON.stringify({
        type: "reply",
        content: "world",
        risk_level: "low",
      }),
    });
    expect(stderr).toContain("Init: probing OS and shell...");
    expect(stderr).toContain("Init: calling LLM to extract system facts...");
    expect(stderr).toMatch(/Init: \d+ facts extracted/);
  });

  test("--verbose shows final round warning", async () => {
    const { stderr } = await wrapVerbose(
      "check tools",
      [
        { type: "command", final: false, content: "echo step1", risk_level: "low" },
        { type: "command", content: "echo done", risk_level: "low" },
      ],
      { maxRounds: 2 },
    );
    expect(stderr).toContain("Round 2/2");
    expect(stderr).toContain("Final round: must return command or answer");
  });
});
