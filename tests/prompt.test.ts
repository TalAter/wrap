import { describe, expect, test } from "bun:test";
import optimized from "../src/prompt.optimized.json";

describe("PROMPT_HASH", () => {
  test("is a 64-char hex string", () => {
    expect(optimized.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Note: we deliberately do NOT verify that promptHash matches the SHA-256
  // of the current prompt components. The hash is produced by `bun run optimize`
  // and is allowed to be stale between optimize runs — hand-edits to the
  // instruction (for immediate-use testing) intentionally don't bump it.
  // See `.claude/skills/editing-prompts.md`.
});
