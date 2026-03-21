import { describe, expect, test } from "bun:test";
import { FEW_SHOT_DEMOS, SCHEMA_TEXT, SYSTEM_PROMPT } from "../src/prompt.optimized.ts";
import { assemblePromptParts } from "../src/prompt.ts";

describe("assemblePromptParts", () => {
  test("returns system prompt string", () => {
    const parts = assemblePromptParts();
    expect(parts.system).toBe(SYSTEM_PROMPT);
  });

  test("returns schema when SCHEMA_TEXT is non-empty", () => {
    const parts = assemblePromptParts();
    expect(parts.schema).toBe(SCHEMA_TEXT);
  });

  test("returns fewShotDemos when FEW_SHOT_DEMOS is non-empty", () => {
    const parts = assemblePromptParts();
    expect(parts.fewShotDemos).toBeDefined();
    expect(parts.fewShotDemos).toHaveLength(FEW_SHOT_DEMOS.length);
    expect(parts.fewShotDemos?.[0].input).toBe(FEW_SHOT_DEMOS[0].input);
    expect(parts.fewShotDemos?.[0].output).toBe(FEW_SHOT_DEMOS[0].output);
  });

  test("all parts are present (smoke test)", () => {
    const parts = assemblePromptParts();
    expect(typeof parts.system).toBe("string");
    expect(parts.system.length).toBeGreaterThan(0);
  });
});
