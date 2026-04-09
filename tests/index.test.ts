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

  test("errors when no LLM configured", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({}),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.\n");
  });

  test("errors when defaultProvider not in providers map", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({
        providers: { anthropic: { model: "haiku" } },
        defaultProvider: "openai",
      }),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.\n");
  });

  test("errors when --model names a provider not in config", async () => {
    const { exitCode, stdout, stderr } = await wrap("--model openai hello", {
      WRAP_CONFIG: JSON.stringify({
        providers: { anthropic: { model: "haiku" } },
        defaultProvider: "anthropic",
      }),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe('Config error: provider "openai" not found in config.\n');
  });

  test("errors when WRAP_MODEL names a provider not in config", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({
        providers: { anthropic: { model: "haiku" } },
        defaultProvider: "anthropic",
      }),
      WRAP_MODEL: "openai",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe('Config error: provider "openai" not found in config.\n');
  });

  test("--model wins over WRAP_MODEL", async () => {
    // CLI flag passes through to resolveProvider, which throws on the named
    // provider. WRAP_MODEL is ignored entirely.
    const { exitCode, stderr } = await wrap("--model openai hello", {
      WRAP_CONFIG: JSON.stringify({
        providers: { anthropic: { model: "haiku" } },
        defaultProvider: "anthropic",
      }),
      WRAP_MODEL: "anthropic",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe('Config error: provider "openai" not found in config.\n');
  });

  test("ollama entry without baseURL → specific validation error", async () => {
    const { exitCode, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({
        providers: { ollama: { model: "llama3.2" } },
        defaultProvider: "ollama",
      }),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe('Config error: provider "ollama" requires baseURL.\n');
  });

  test("unknown provider missing required fields → specific validation error", async () => {
    const { exitCode, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({
        providers: { groq: { model: "llama" } },
        defaultProvider: "groq",
      }),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe('Config error: provider "groq" requires baseURL, apiKey, and model.\n');
  });

  test("errors on malformed WRAP_CONFIG", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: "{broken",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Config error: WRAP_CONFIG contains invalid JSON.\n");
  });

  test("shows clean error when LLM provider fails", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({}),
      WRAP_TEST_RESPONSE: "ERROR:something went wrong",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    // Should be a clean error message, not a stack trace
    expect(stderr).not.toContain("at ");
    expect(stderr.trim().length).toBeGreaterThan(0);
  });

  test("answer: prints to stdout and exits 0", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("what is 6*7", {
      type: "reply",
      content: "42",
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("42\n");
    expect(stderr).toBe("");
  });

  test("errors on empty or whitespace content", async () => {
    const [emptyAnswer, emptyCommand, whitespace] = await Promise.all([
      wrapMock("hello", { type: "reply", content: "", risk_level: "low" }),
      wrapMock("hello", { type: "command", content: "", risk_level: "low" }),
      wrapMock("hello", { type: "reply", content: "   ", risk_level: "low" }),
    ]);
    expect(emptyAnswer.exitCode).toBe(1);
    expect(emptyAnswer.stdout).toBe("");
    expect(emptyAnswer.stderr).toContain("empty response");
    expect(emptyCommand.exitCode).toBe(1);
    expect(emptyCommand.stdout).toBe("");
    expect(emptyCommand.stderr).toContain("empty response");
    expect(whitespace.exitCode).toBe(1);
    expect(whitespace.stdout).toBe("");
    expect(whitespace.stderr).toContain("empty response");
  });

  test("errors on invalid JSON from LLM", async () => {
    const { exitCode, stdout, stderr } = await wrap("hello", {
      WRAP_CONFIG: JSON.stringify({}),
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

  test("command: runs in interactive shell so aliases resolve", async () => {
    const { exitCode, stdout } = await wrapMock("check shell", {
      type: "command",
      content: 'echo "$-"',
      risk_level: "low",
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toContain("i");
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

  test("probe → command: executes probe then runs final command", async () => {
    const { exitCode, stdout } = await wrapMock("find image tools", [
      {
        type: "probe",
        content: "echo found-sips",
        risk_level: "low",
        explanation: "Checking image tools",
      },
      { type: "command", content: "echo converted", risk_level: "low" },
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("converted\n");
    expect(stdout).not.toContain("found-sips");
  });

  test("probe: shows discovery indicator on stderr", async () => {
    const { stderr } = await wrapMock("find tools", [
      {
        type: "probe",
        content: "echo test",
        risk_level: "low",
        explanation: "Checking available tools",
      },
      { type: "command", content: "echo done", risk_level: "low" },
    ]);
    expect(stderr).toContain("🔍");
    expect(stderr).toContain("Checking available tools");
  });

  test("probe: shows web indicator on stderr for URL-fetching probes", async () => {
    const { stderr } = await wrapMock("read the page", [
      {
        type: "probe",
        content: "curl -sL https://example.com",
        risk_level: "low",
        explanation: "Reading example.com",
      },
      { type: "reply", content: "Done.", risk_level: "low" },
    ]);
    expect(stderr).toContain("🌐");
    expect(stderr).not.toContain("🔍");
    expect(stderr).toContain("Reading example.com");
  });

  test("probe → answer: returns answer after probe", async () => {
    const { exitCode, stdout } = await wrapMock("what shell am I using", [
      { type: "probe", content: "echo /bin/zsh", risk_level: "low", explanation: "Checking shell" },
      { type: "reply", content: "You're using zsh", risk_level: "low" },
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("You're using zsh\n");
  });

  test("probe: multiple probes before final command", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("convert images", [
      {
        type: "probe",
        content: "echo /usr/bin/sips",
        risk_level: "low",
        explanation: "Checking sips",
      },
      {
        type: "probe",
        content: "echo png-support",
        risk_level: "low",
        explanation: "Checking PNG support",
      },
      { type: "command", content: "echo converted", risk_level: "low" },
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("converted\n");
    expect(stderr).toContain("Checking sips");
    expect(stderr).toContain("Checking PNG support");
  });

  test("probe: budget exhaustion after all rounds are probes", async () => {
    const { exitCode, stdout, stderr } = await wrapMock(
      "check tools",
      [
        { type: "probe", content: "echo probe1", risk_level: "low" },
        { type: "probe", content: "echo probe2", risk_level: "low" },
      ],
      { maxRounds: 2 },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("rounds");
  });

  test("probe: memory updates from probes are saved", async () => {
    const { exitCode, wrapHome } = await wrapMock("find tools", [
      {
        type: "probe",
        content: "echo test",
        risk_level: "low",
        memory_updates: [{ fact: "sips is available", scope: "/" }],
        memory_updates_message: "Noted: sips available",
      },
      { type: "command", content: "echo done", risk_level: "low" },
    ]);
    expect(exitCode).toBe(0);
    const memPath = join(wrapHome, "memory.json");
    const memory = JSON.parse(readFileSync(memPath, "utf-8"));
    expect(memory["/"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ fact: "sips is available" })]),
    );
  });

  test("probe: failed probe (non-zero exit) still feeds back to LLM", async () => {
    const { exitCode, stdout, stderr } = await wrapMock("check tools", [
      {
        type: "probe",
        content: "echo probe-ran >&2; exit 42",
        risk_level: "low",
        explanation: "Checking tool",
      },
      { type: "command", content: "echo done", risk_level: "low" },
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("done\n");
    expect(stderr).toContain("🔍");
  });

  test("probe: non-low risk probe triggers retry", async () => {
    const { exitCode, stdout } = await wrapMock("delete tables", [
      // First response: high-risk probe (triggers risk-level retry)
      { type: "probe", content: "psql -c 'DROP TABLE'", risk_level: "high" },
      // Retry response: corrected to a command
      { type: "command", content: "echo corrected", risk_level: "low" },
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("corrected\n");
  });

  test("maxRounds=1: command succeeds on single-round budget", async () => {
    const { exitCode, stdout } = await wrapMock(
      "list files",
      [{ type: "command", content: "echo done", risk_level: "low" }],
      { maxRounds: 1 },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("done\n");
  });

  test("e2e: first run inits memory, then query succeeds", async () => {
    const response = JSON.stringify({ type: "command", content: "echo hi", risk_level: "low" });
    const { exitCode, stdout, stderr, wrapHome } = await wrap("say hi", {
      WRAP_CONFIG: JSON.stringify({}),
      WRAP_TEST_RESPONSE: response,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hi\n");
    expect(stderr).toContain("Learning about your system");
    expect(stderr).toContain("Detected");
    const memoryPath = join(wrapHome, "memory.json");
    expect(existsSync(memoryPath)).toBe(true);
    const memory = JSON.parse(readFileSync(memoryPath, "utf-8"));
    expect(typeof memory).toBe("object");
    expect(memory["/"]).toBeDefined();
    expect(memory["/"].length).toBeGreaterThan(0);
    expect(memory["/"][0]).toHaveProperty("fact");
  });

  test("memory_updates: display prefix based on scope", async () => {
    const [globalScope, nonGlobal, mixed] = await Promise.all([
      wrapMock("list files", {
        type: "command",
        content: "echo hi",
        risk_level: "low",
        memory_updates: [{ fact: "Uses zsh", scope: "/" }],
        memory_updates_message: "Noted: you use zsh",
      }),
      wrapMock("list files", {
        type: "command",
        content: "echo hi",
        risk_level: "low",
        memory_updates: [{ fact: "Uses bun", scope: "/tmp" }],
        memory_updates_message: "Noted: uses bun",
      }),
      wrapMock("list files", {
        type: "command",
        content: "echo hi",
        risk_level: "low",
        memory_updates: [
          { fact: "Uses zsh", scope: "/" },
          { fact: "Uses bun", scope: "/tmp" },
        ],
        memory_updates_message: "Noted: zsh and bun",
      }),
    ]);
    // Global-only: plain prefix, no directory
    expect(globalScope.exitCode).toBe(0);
    expect(globalScope.stderr).toContain("🧠 Noted: you use zsh");
    expect(globalScope.stderr).not.toMatch(/🧠 \(/);
    // Non-global: shows directory prefix
    expect(nonGlobal.exitCode).toBe(0);
    expect(nonGlobal.stderr).toMatch(/🧠 \(.*\) Noted: uses bun/);
    // Mixed: shows deepest non-global scope
    expect(mixed.exitCode).toBe(0);
    expect(mixed.stderr).toMatch(/🧠 \(.*\) Noted: zsh and bun/);
  });
});

describe("piped input", () => {
  test("pipe + CLI args: LLM receives both piped content and prompt", async () => {
    const { exitCode, stdout } = await wrapMock(
      "explain this",
      { type: "reply", content: "It's an error log", risk_level: "low" },
      undefined,
      "ERROR: connection refused",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("It's an error log\n");
  });

  test("pipe only (no args): proceeds to query, not --help", async () => {
    const { exitCode, stdout } = await wrapMock(
      "",
      { type: "reply", content: "42 lines", risk_level: "low" },
      undefined,
      "line1\nline2\nline3",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("42 lines\n");
  });

  test("empty pipe: treated as no piped input, shows help", async () => {
    const { exitCode, stdout } = await wrap(undefined, undefined, "");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("whitespace-only pipe: treated as no piped input, shows help", async () => {
    const { exitCode, stdout } = await wrap(undefined, undefined, "   \n\t  ");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("pipe_stdin: true — command receives piped content on stdin", async () => {
    const { exitCode, stdout } = await wrapMock(
      "count lines",
      { type: "command", content: "wc -l", risk_level: "low", pipe_stdin: true },
      undefined,
      "line1\nline2\nline3\n",
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("3");
  });

  test("pipe_stdin: false — command does not receive piped content", async () => {
    const { exitCode, stdout } = await wrapMock(
      "list files",
      { type: "command", content: "echo hello", risk_level: "low", pipe_stdin: false },
      undefined,
      "this should not be piped",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hello\n");
  });

  test("pipe_stdin: true on probe — probe receives piped content", async () => {
    const { exitCode, stdout } = await wrapMock(
      "count lines",
      [
        { type: "probe", content: "wc -l", risk_level: "low", pipe_stdin: true },
        { type: "reply", content: "3 lines", risk_level: "low" },
      ],
      undefined,
      "a\nb\nc\n",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("3 lines\n");
  });

  test("piped content not parsed as flags", async () => {
    const { exitCode, stdout } = await wrapMock(
      "explain this",
      { type: "reply", content: "That's a version flag", risk_level: "low" },
      undefined,
      "--version",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("That's a version flag\n");
    // Should NOT have triggered --version subcommand
    expect(stdout).not.toContain("wrap v");
  });

  test("piped input logged in entry", async () => {
    const { wrapHome } = await wrapMock(
      "explain",
      { type: "reply", content: "ok", risk_level: "low" },
      undefined,
      "log data here",
    );
    const logPath = join(wrapHome, "logs", "wrap.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.piped_input).toBe("log data here");
  });

  test("large piped input truncated in log", async () => {
    const largeInput = "x".repeat(5000);
    const { wrapHome } = await wrapMock(
      "explain",
      { type: "reply", content: "ok", risk_level: "low" },
      undefined,
      largeInput,
    );
    const logPath = join(wrapHome, "logs", "wrap.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.piped_input).toContain("[…truncated, 5000 chars total]");
    expect(entry.piped_input.length).toBeLessThan(5000);
  });

  test("no piped input: log omits piped_input field", async () => {
    const { wrapHome } = await wrapMock("hello", {
      type: "reply",
      content: "ok",
      risk_level: "low",
    });
    const logPath = join(wrapHome, "logs", "wrap.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect("piped_input" in entry).toBe(false);
  });
});
