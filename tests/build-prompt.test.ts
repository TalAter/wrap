import { describe, expect, test } from "bun:test";
import { buildPromptScaffold, type PromptConfig } from "../src/llm/build-prompt.ts";

const config: PromptConfig = {
  instruction: "You are a CLI tool.",
  schemaInstruction: "Respond with JSON:",
  schemaText: "z.object({ type: z.string() })",
  memoryRecencyInstruction: "Later facts override earlier ones.",
  toolsScopeInstruction: "Tools are not exhaustive.",
  voiceInstructions: "Be concise.",
  tempDirPrinciple: "Use $WRAP_TEMP_DIR for intermediate artifacts.",
  finalFlagInstruction: "Set final: false for non-terminal discovery steps.",
  wrapNoteInstruction: "<wrap-note> tags are session metadata.",
  fewShotExamples: [{ input: "list files", output: '{"type":"command","content":"ls"}' }],
  fewShotSeparator: "Now handle the following request.",
  sectionUserRequest: "## User's request",
};

describe("buildPromptScaffold — system message", () => {
  test("contains instruction", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("You are a CLI tool.");
  });

  test("contains memory recency instruction", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("Later facts override earlier ones.");
  });

  test("contains tools scope instruction", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("Tools are not exhaustive.");
  });

  test("contains temp-dir principle", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("Use $WRAP_TEMP_DIR for intermediate artifacts.");
  });

  test("contains voice instructions", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("Be concise.");
  });

  test("contains wrap-note instruction", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("<wrap-note> tags are session metadata.");
  });

  test("contains schema instruction + schema text", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("Respond with JSON:");
    expect(result.system).toContain("z.object({ type: z.string() })");
  });

  test("omits schema block when schemaText is empty", () => {
    const noSchema = { ...config, schemaText: "" };
    const result = buildPromptScaffold(noSchema, "");
    expect(result.system).not.toContain("Respond with JSON:");
  });

  test("omits attached-input block when attachedInputInstruction is undefined", () => {
    const result = buildPromptScaffold(config, "");
    // If the conditional was bypassed, `undefined` would be pushed into
    // systemParts and coerced to "" by `join`, producing a 3+ newline run
    // between the surrounding sections.
    expect(result.system).not.toMatch(/\n\n\n/);
  });

  test("system parts joined by double newlines", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.system).toContain("You are a CLI tool.\n\nLater facts override earlier ones.");
  });
});

describe("buildPromptScaffold — prefix messages", () => {
  test("few-shot examples become user/assistant pairs", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.prefixMessages[0]).toEqual({ role: "user", content: "list files" });
    expect(result.prefixMessages[1]).toEqual({
      role: "assistant",
      content: '{"type":"command","content":"ls"}',
    });
  });

  test("separator follows few-shot examples", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.prefixMessages[2]).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });

  test("no few-shot examples: empty prefixMessages", () => {
    const noExamples = { ...config, fewShotExamples: [] };
    const result = buildPromptScaffold(noExamples, "");
    expect(result.prefixMessages.length).toBe(0);
  });

  test("multiple few-shot examples in order", () => {
    const multi = {
      ...config,
      fewShotExamples: [
        { input: "first", output: "out1" },
        { input: "second", output: "out2" },
      ],
    };
    const result = buildPromptScaffold(multi, "");
    expect(result.prefixMessages[0]).toEqual({ role: "user", content: "first" });
    expect(result.prefixMessages[1]).toEqual({ role: "assistant", content: "out1" });
    expect(result.prefixMessages[2]).toEqual({ role: "user", content: "second" });
    expect(result.prefixMessages[3]).toEqual({ role: "assistant", content: "out2" });
    expect(result.prefixMessages[4]).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });
});

describe("buildPromptScaffold — context + framing", () => {
  test("exposes contextString verbatim", () => {
    const result = buildPromptScaffold(config, "## System facts\n- macOS");
    expect(result.contextString).toBe("## System facts\n- macOS");
  });

  test("exposes sectionUserRequest from config", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.sectionUserRequest).toBe("## User's request");
  });

  test("empty context is preserved as empty string", () => {
    const result = buildPromptScaffold(config, "");
    expect(result.contextString).toBe("");
  });
});
