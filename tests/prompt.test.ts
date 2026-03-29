import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CWD_PREFIX,
  FEW_SHOT_EXAMPLES,
  FEW_SHOT_SEPARATOR,
  MEMORY_RECENCY_INSTRUCTION,
  PIPED_OUTPUT_INSTRUCTION,
  PROMPT_HASH,
  SCHEMA_INSTRUCTION,
  SCHEMA_TEXT,
  SECTION_DETECTED_TOOLS,
  SECTION_FACTS_ABOUT,
  SECTION_SYSTEM_FACTS,
  SECTION_USER_REQUEST,
  SYSTEM_PROMPT,
  TOOLS_SCOPE_INSTRUCTION,
  VOICE_INSTRUCTIONS,
} from "../src/prompt.optimized.ts";

describe("PROMPT_HASH", () => {
  test("is a 64-char hex string", () => {
    expect(PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches SHA-256 of prompt components", () => {
    const manifest = [
      ["SYSTEM_PROMPT", (SYSTEM_PROMPT || "").trim()],
      ["MEMORY_RECENCY_INSTRUCTION", MEMORY_RECENCY_INSTRUCTION],
      ["TOOLS_SCOPE_INSTRUCTION", TOOLS_SCOPE_INSTRUCTION],
      ["VOICE_INSTRUCTIONS", VOICE_INSTRUCTIONS],
      ["SCHEMA_INSTRUCTION", SCHEMA_INSTRUCTION],
      ["SCHEMA_TEXT", (SCHEMA_TEXT || "").trim()],
      ["FEW_SHOT_SEPARATOR", FEW_SHOT_SEPARATOR],
      ["SECTION_SYSTEM_FACTS", SECTION_SYSTEM_FACTS],
      ["SECTION_FACTS_ABOUT", SECTION_FACTS_ABOUT],
      ["SECTION_DETECTED_TOOLS", SECTION_DETECTED_TOOLS],
      ["SECTION_USER_REQUEST", SECTION_USER_REQUEST],
      ["CWD_PREFIX", CWD_PREFIX],
      ["PIPED_OUTPUT_INSTRUCTION", PIPED_OUTPUT_INSTRUCTION],
      ["FEW_SHOT_EXAMPLES", FEW_SHOT_EXAMPLES.length > 0 ? [...FEW_SHOT_EXAMPLES] : []],
    ];
    const input = JSON.stringify(manifest);
    const expected = createHash("sha256").update(input).digest("hex");
    expect(PROMPT_HASH).toBe(expected);
  });
});
