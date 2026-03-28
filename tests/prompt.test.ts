import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  FEW_SHOT_EXAMPLES,
  PROMPT_HASH,
  SCHEMA_TEXT,
  SYSTEM_PROMPT,
} from "../src/prompt.optimized.ts";

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
