import { describe, expect, test } from "bun:test";
import { initLLM } from "../src/llm/index.ts";
import { claudeCodeProvider } from "../src/llm/providers/claude-code.ts";
import { testProvider } from "../src/llm/providers/test.ts";

describe("initLLM factory", () => {
  test("returns a function for test provider", () => {
    const llm = initLLM({ type: "test" });
    expect(typeof llm).toBe("function");
  });

  test("returns a function for claude-code provider", () => {
    const llm = initLLM({ type: "claude-code" });
    expect(typeof llm).toBe("function");
  });

  test("throws on unrecognized provider type", () => {
    // @ts-expect-error testing invalid provider type
    expect(() => initLLM({ type: "nonexistent" })).toThrow(
      'Config error: unrecognized provider "nonexistent".',
    );
  });
});

describe("testProvider", () => {
  test("returns valid JSON response with prompt as command", async () => {
    const llm = testProvider();
    const result = await llm("hello world");
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ type: "command", command: "hello world", risk_level: "low" });
  });

  test("returns WRAP_TEST_RESPONSE when set", async () => {
    const prev = process.env.WRAP_TEST_RESPONSE;
    try {
      process.env.WRAP_TEST_RESPONSE = '{"type":"answer","answer":"custom","risk_level":"low"}';
      const llm = testProvider();
      const result = await llm("anything");
      expect(result).toBe('{"type":"answer","answer":"custom","risk_level":"low"}');
    } finally {
      if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
      else process.env.WRAP_TEST_RESPONSE = prev;
    }
  });
});

describe("claudeCodeProvider", () => {
  test("returns a function", () => {
    const llm = claudeCodeProvider({ type: "claude-code" });
    expect(typeof llm).toBe("function");
  });

  test("uses default model when none specified", () => {
    // Just verifying it initializes without error
    const llm = claudeCodeProvider({ type: "claude-code" });
    expect(typeof llm).toBe("function");
  });
});
