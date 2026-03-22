import { describe, expect, test } from "bun:test";
import { initProvider } from "../src/llm/index.ts";
import { claudeCodeProvider } from "../src/llm/providers/claude-code.ts";
import { testProvider } from "../src/llm/providers/test.ts";

describe("initProvider factory", () => {
  test("returns a provider with runPrompt and runCommandPrompt", () => {
    const provider = initProvider({ type: "test" });
    expect(typeof provider.runPrompt).toBe("function");
    expect(typeof provider.runCommandPrompt).toBe("function");
  });

  test("returns a provider for claude-code", () => {
    const provider = initProvider({ type: "claude-code" });
    expect(typeof provider.runPrompt).toBe("function");
    expect(typeof provider.runCommandPrompt).toBe("function");
  });

  test("throws on unrecognized provider type", () => {
    // @ts-expect-error testing invalid provider type
    expect(() => initProvider({ type: "nonexistent" })).toThrow(
      'Config error: unrecognized provider "nonexistent".',
    );
  });
});

describe("testProvider", () => {
  describe("runPrompt", () => {
    test("returns the user prompt as-is", async () => {
      const provider = testProvider();
      const result = await provider.runPrompt("system prompt", "hello world");
      expect(result).toBe("hello world");
    });

    test("returns WRAP_TEST_RESPONSE when set", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = "custom response";
        const provider = testProvider();
        const result = await provider.runPrompt("system", "user");
        expect(result).toBe("custom response");
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });
  });

  describe("runCommandPrompt", () => {
    test("returns valid JSON response with prompt as command", async () => {
      const provider = testProvider();
      const result = await provider.runCommandPrompt("hello world");
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ type: "command", command: "hello world", risk_level: "low" });
    });

    test("returns WRAP_TEST_RESPONSE when set", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = '{"type":"answer","answer":"custom","risk_level":"low"}';
        const provider = testProvider();
        const result = await provider.runCommandPrompt("anything");
        expect(result).toBe('{"type":"answer","answer":"custom","risk_level":"low"}');
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });
  });
});

describe("claudeCodeProvider", () => {
  test("returns a provider with runPrompt and runCommandPrompt", () => {
    const provider = claudeCodeProvider({ type: "claude-code" });
    expect(typeof provider.runPrompt).toBe("function");
    expect(typeof provider.runCommandPrompt).toBe("function");
  });
});
