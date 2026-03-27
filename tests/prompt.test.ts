import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  FEW_SHOT_EXAMPLES,
  PROMPT_HASH,
  SCHEMA_TEXT,
  SYSTEM_PROMPT,
} from "../src/prompt.optimized.ts";
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

  test("returns fewShotExamples when FEW_SHOT_EXAMPLES is non-empty", () => {
    const parts = assemblePromptParts();
    expect(parts.fewShotExamples).toBeDefined();
    expect(parts.fewShotExamples).toHaveLength(FEW_SHOT_EXAMPLES.length);
    expect(parts.fewShotExamples?.[0].input).toBe(FEW_SHOT_EXAMPLES[0].input);
    expect(parts.fewShotExamples?.[0].output).toBe(FEW_SHOT_EXAMPLES[0].output);
  });

  test("all parts are present (smoke test)", () => {
    const parts = assemblePromptParts();
    expect(typeof parts.system).toBe("string");
    expect(parts.system.length).toBeGreaterThan(0);
  });
});

describe("PROMPT_HASH", () => {
  test("is a 64-char hex string", () => {
    expect(PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches SHA-256 of prompt components", () => {
    const input = [
      (SYSTEM_PROMPT || "").trim(),
      (SCHEMA_TEXT || "").trim(),
      JSON.stringify(FEW_SHOT_EXAMPLES.length > 0 ? [...FEW_SHOT_EXAMPLES] : []),
    ].join("\n");
    const expected = createHash("sha256").update(input).digest("hex");
    expect(PROMPT_HASH).toBe(expected);
  });
});
