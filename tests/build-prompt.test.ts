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
  fewShotExamples: [{ input: "list files", output: '{"type":"command","content":"ls"}' }],
  fewShotSeparator: "Now handle the following request.",
  sectionUserRequest: "## User's request",
};

describe("buildPromptScaffold — system message", () => {
  test("contains instruction", () => {
    const result = buildPromptScaffold(config, "", "test query");
    expect(result.system).toContain("You are a CLI tool.");
  });

  test("contains memory recency instruction", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.system).toContain("Later facts override earlier ones.");
  });

  test("contains tools scope instruction", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.system).toContain("Tools are not exhaustive.");
  });

  test("contains temp-dir principle", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.system).toContain("Use $WRAP_TEMP_DIR for intermediate artifacts.");
  });

  test("contains voice instructions", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.system).toContain("Be concise.");
  });

  test("contains schema instruction + schema text", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.system).toContain("Respond with JSON:");
    expect(result.system).toContain("z.object({ type: z.string() })");
  });

  test("omits schema block when schemaText is empty", () => {
    const noSchema = { ...config, schemaText: "" };
    const result = buildPromptScaffold(noSchema, "", "test");
    expect(result.system).not.toContain("Respond with JSON:");
  });

  test("system parts joined by double newlines", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.system).toContain("You are a CLI tool.\n\nLater facts override earlier ones.");
  });
});

describe("buildPromptScaffold — prefix messages", () => {
  test("few-shot examples become user/assistant pairs", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.prefixMessages[0]).toEqual({ role: "user", content: "list files" });
    expect(result.prefixMessages[1]).toEqual({
      role: "assistant",
      content: '{"type":"command","content":"ls"}',
    });
  });

  test("separator follows few-shot examples", () => {
    const result = buildPromptScaffold(config, "", "test");
    expect(result.prefixMessages[2]).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });

  test("no few-shot examples: empty prefixMessages", () => {
    const noExamples = { ...config, fewShotExamples: [] };
    const result = buildPromptScaffold(noExamples, "", "test");
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
    const result = buildPromptScaffold(multi, "", "test");
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

describe("buildPromptScaffold — initial user text", () => {
  test("contains context + user request header + query", () => {
    const result = buildPromptScaffold(config, "## System facts\n- macOS", "find files");
    expect(result.initialUserText).toContain("## System facts\n- macOS");
    expect(result.initialUserText).toContain("## User's request\nfind files");
  });

  test("context and user request separated by double newline", () => {
    const result = buildPromptScaffold(config, "context here", "query here");
    expect(result.initialUserText).toContain("context here\n\n## User's request\nquery here");
  });

  test("empty context still includes user request", () => {
    const result = buildPromptScaffold(config, "", "query here");
    expect(result.initialUserText).toContain("## User's request\nquery here");
  });
});
