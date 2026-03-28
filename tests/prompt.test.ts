import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  FEW_SHOT_EXAMPLES,
  MEMORY_RECENCY_INSTRUCTION,
  PROMPT_HASH,
  SCHEMA_TEXT,
  SYSTEM_PROMPT,
  TOOLS_SCOPE_INSTRUCTION,
  VOICE_INSTRUCTIONS,
} from "../src/prompt.optimized.ts";

describe("PROMPT_HASH", () => {
  test("is a 64-char hex string", () => {
    expect(PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches SHA-256 of prompt components", () => {
    const fullSystem = [
      (SYSTEM_PROMPT || "").trim(),
      MEMORY_RECENCY_INSTRUCTION,
      TOOLS_SCOPE_INSTRUCTION,
      VOICE_INSTRUCTIONS,
    ].join("\n\n");
    const input = [
      fullSystem,
      (SCHEMA_TEXT || "").trim(),
      JSON.stringify(FEW_SHOT_EXAMPLES.length > 0 ? [...FEW_SHOT_EXAMPLES] : []),
    ].join("\n");
    const expected = createHash("sha256").update(input).digest("hex");
    expect(PROMPT_HASH).toBe(expected);
  });
});
