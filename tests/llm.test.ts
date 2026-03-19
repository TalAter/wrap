import { describe, expect, test } from "bun:test";
import { initLLM } from "../src/llm.ts";

describe("initLLM", () => {
  test("returns a function for test provider", () => {
    const llm = initLLM({ type: "test" });
    expect(typeof llm).toBe("function");
  });

  test("test provider echoes prompt back", async () => {
    const llm = initLLM({ type: "test" });
    const result = await llm("hello world");
    expect(result).toBe("hello world");
  });

  test("returns a function for claude-code provider", () => {
    const llm = initLLM({ type: "claude-code" });
    expect(typeof llm).toBe("function");
  });

  test("throws on unrecognized provider type", () => {
    expect(() => initLLM({ type: "nonexistent" })).toThrow(
      'Config error: unrecognized provider "nonexistent".',
    );
  });
});
