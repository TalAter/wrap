import { describe, expect, test } from "bun:test";
import { buildPrompt, type PromptConfig } from "../src/llm/build-prompt.ts";

const config: PromptConfig = {
  instruction: "You are a CLI tool.",
  schemaInstruction: "Respond with JSON:",
  schemaText: "z.object({ type: z.string() })",
  memoryRecencyInstruction: "Later facts override earlier ones.",
  toolsScopeInstruction: "Tools are not exhaustive.",
  voiceInstructions: "Be concise.",
  fewShotExamples: [{ input: "list files", output: '{"type":"command","content":"ls"}' }],
  fewShotSeparator: "Now handle the following request.",
  sectionUserRequest: "## User's request",
};

describe("buildPrompt — system message", () => {
  test("contains instruction", () => {
    const result = buildPrompt(config, "", "test query");
    expect(result.system).toContain("You are a CLI tool.");
  });

  test("contains memory recency instruction", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.system).toContain("Later facts override earlier ones.");
  });

  test("contains tools scope instruction", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.system).toContain("Tools are not exhaustive.");
  });

  test("contains voice instructions", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.system).toContain("Be concise.");
  });

  test("contains schema instruction + schema text", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.system).toContain("Respond with JSON:");
    expect(result.system).toContain("z.object({ type: z.string() })");
  });

  test("omits schema block when schemaText is empty", () => {
    const noSchema = { ...config, schemaText: "" };
    const result = buildPrompt(noSchema, "", "test");
    expect(result.system).not.toContain("Respond with JSON:");
  });

  test("system parts joined by double newlines", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.system).toContain("You are a CLI tool.\n\nLater facts override earlier ones.");
  });
});

describe("buildPrompt — messages", () => {
  test("few-shot examples become user/assistant pairs", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.messages[0]).toEqual({ role: "user", content: "list files" });
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: '{"type":"command","content":"ls"}',
    });
  });

  test("separator follows few-shot examples", () => {
    const result = buildPrompt(config, "", "test");
    expect(result.messages[2]).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });

  test("final user message contains context + user request header + query", () => {
    const result = buildPrompt(config, "## System facts\n- macOS", "find files");
    const last = result.messages[result.messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("## System facts\n- macOS");
    expect(last?.content).toContain("## User's request\nfind files");
  });

  test("context and user request separated by double newline", () => {
    const result = buildPrompt(config, "context here", "query here");
    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toContain("context here\n\n## User's request\nquery here");
  });

  test("empty context still includes user request", () => {
    const result = buildPrompt(config, "", "query here");
    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toContain("## User's request\nquery here");
  });

  test("no few-shot examples: no separator, just final user message", () => {
    const noExamples = { ...config, fewShotExamples: [] };
    const result = buildPrompt(noExamples, "", "test");
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  test("message count: 2 per example + separator + final", () => {
    const result = buildPrompt(config, "", "test");
    // 1 example × 2 + 1 separator + 1 final = 4
    expect(result.messages.length).toBe(4);
  });

  test("multiple few-shot examples in order", () => {
    const multi = {
      ...config,
      fewShotExamples: [
        { input: "first", output: "out1" },
        { input: "second", output: "out2" },
      ],
    };
    const result = buildPrompt(multi, "", "test");
    expect(result.messages[0]).toEqual({ role: "user", content: "first" });
    expect(result.messages[1]).toEqual({ role: "assistant", content: "out1" });
    expect(result.messages[2]).toEqual({ role: "user", content: "second" });
    expect(result.messages[3]).toEqual({ role: "assistant", content: "out2" });
    expect(result.messages[4]).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });
});
