import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import constants from "../src/prompt.constants.json";
import optimized from "../src/prompt.optimized.json";

describe("PROMPT_HASH", () => {
  test("is a 64-char hex string", () => {
    expect(optimized.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches SHA-256 of prompt components from both JSON files", () => {
    const manifest = [
      ["SYSTEM_PROMPT", (optimized.instruction || "").trim()],
      ["MEMORY_RECENCY_INSTRUCTION", constants.memoryRecencyInstruction],
      ["TOOLS_SCOPE_INSTRUCTION", constants.toolsScopeInstruction],
      ["VOICE_INSTRUCTIONS", constants.voiceInstructions],
      ["SCHEMA_INSTRUCTION", constants.schemaInstruction],
      ["SCHEMA_TEXT", (optimized.schemaText || "").trim()],
      ["FEW_SHOT_SEPARATOR", constants.fewShotSeparator],
      ["SECTION_SYSTEM_FACTS", constants.sectionSystemFacts],
      ["SECTION_FACTS_ABOUT", constants.sectionFactsAbout],
      ["SECTION_DETECTED_TOOLS", constants.sectionDetectedTools],
      ["SECTION_UNAVAILABLE_TOOLS", constants.sectionUnavailableTools],
      ["SECTION_CWD_FILES", constants.sectionCwdFiles],
      ["SECTION_USER_REQUEST", constants.sectionUserRequest],
      ["CWD_PREFIX", constants.cwdPrefix],
      ["PIPED_OUTPUT_INSTRUCTION", constants.pipedOutputInstruction],
      ["FEW_SHOT_EXAMPLES", optimized.fewShotExamples],
    ];
    const input = JSON.stringify(manifest);
    const expected = createHash("sha256").update(input).digest("hex");
    expect(optimized.promptHash).toBe(expected);
  });
});
