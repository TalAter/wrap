import { describe, expect, test } from "bun:test";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
import { initProvider, runCommandPrompt } from "../src/llm/index.ts";
import { claudeCodeProvider } from "../src/llm/providers/claude-code.ts";
import { testProvider } from "../src/llm/providers/test.ts";
import type { PromptInput } from "../src/llm/types.ts";

const input: PromptInput = {
  system: "you are a test",
  messages: [{ role: "user", content: "hello world" }],
};

describe("initProvider factory", () => {
  test("returns a provider with runPrompt", () => {
    const provider = initProvider({ type: "test" });
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for claude-code", () => {
    const provider = initProvider({ type: "claude-code" });
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for anthropic", () => {
    const provider = initProvider({ type: "anthropic" });
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for openai", () => {
    const provider = initProvider({ type: "openai" });
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("throws on unrecognized provider type", () => {
    // @ts-expect-error testing invalid provider type
    expect(() => initProvider({ type: "nonexistent" })).toThrow(
      'Config error: unrecognized provider "nonexistent".',
    );
  });
});

describe("testProvider", () => {
  describe("runPrompt (no schema)", () => {
    test("returns last user message content", async () => {
      const provider = testProvider();
      const result = await provider.runPrompt(input);
      expect(result).toBe("hello world");
    });

    test("returns WRAP_TEST_RESPONSE when set", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = "custom response";
        const provider = testProvider();
        const result = await provider.runPrompt(input);
        expect(result).toBe("custom response");
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });
  });

  describe("runPrompt (with schema)", () => {
    test("parses and validates JSON against schema", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = JSON.stringify({
          type: "command",
          content: "echo hi",
          risk_level: "low",
        });
        const provider = testProvider();
        const result = await provider.runPrompt(input, CommandResponseSchema);
        expect(result).toEqual({
          type: "command",
          content: "echo hi",
          risk_level: "low",
        });
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });

    test("throws on schema validation failure", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = JSON.stringify({ bad: "data" });
        const provider = testProvider();
        expect(provider.runPrompt(input, CommandResponseSchema)).rejects.toThrow();
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });
  });
});

describe("runCommandPrompt", () => {
  test("returns typed CommandResponse via test provider", async () => {
    const prev = process.env.WRAP_TEST_RESPONSE;
    try {
      process.env.WRAP_TEST_RESPONSE = JSON.stringify({
        type: "command",
        content: "ls",
        risk_level: "low",
      });
      const provider = testProvider();
      const result = await runCommandPrompt(provider, input);
      expect(result.type).toBe("command");
      expect(result.content).toBe("ls");
    } finally {
      if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
      else process.env.WRAP_TEST_RESPONSE = prev;
    }
  });
});

describe("claudeCodeProvider", () => {
  test("returns a provider with runPrompt", () => {
    const provider = claudeCodeProvider({ type: "claude-code" });
    expect(typeof provider.runPrompt).toBe("function");
  });
});
