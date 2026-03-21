import { describe, expect, test } from "bun:test";
import { initLLM, stripFences } from "../src/llm.ts";

describe("initLLM", () => {
  test("returns a function for test provider", () => {
    const llm = initLLM({ type: "test" });
    expect(typeof llm).toBe("function");
  });

  test("test provider returns valid JSON response with prompt as command", async () => {
    const llm = initLLM({ type: "test" });
    const result = await llm("hello world");
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ type: "command", command: "hello world", risk_level: "low" });
  });

  test("returns a function for claude-code provider", () => {
    const llm = initLLM({ type: "claude-code" });
    expect(typeof llm).toBe("function");
  });

  test("throws on unrecognized provider type", () => {
    expect(() => initLLM({ type: "nonexistent" })).toThrow(
      'Config error: unrecognized provider "nonexistent".',
    );
  });
});

describe("stripFences", () => {
  test("strips ```json fences", () => {
    const input = '```json\n{"type": "command"}\n```';
    expect(stripFences(input)).toBe('{"type": "command"}');
  });

  test("strips ```bash fences", () => {
    const input = '```bash\n{"type": "command"}\n```';
    expect(stripFences(input)).toBe('{"type": "command"}');
  });

  test("strips bare ``` fences", () => {
    const input = '```\n{"type": "command"}\n```';
    expect(stripFences(input)).toBe('{"type": "command"}');
  });

  test("returns raw JSON unchanged", () => {
    const input = '{"type": "command"}';
    expect(stripFences(input)).toBe('{"type": "command"}');
  });

  test("handles multiline JSON inside fences", () => {
    const input = '```json\n{\n  "type": "command",\n  "command": "ls"\n}\n```';
    expect(stripFences(input)).toBe('{\n  "type": "command",\n  "command": "ls"\n}');
  });

  test("does not strip when multiple code blocks present", () => {
    const input = '```json\n{"type": "command"}\n```\n\nSome prose\n\n```\nnetstat -ano\n```';
    expect(stripFences(input)).toBe(input);
  });

  test("does not strip when prose surrounds a code block", () => {
    const input = 'Here is the command:\n```json\n{"type": "command"}\n```\n';
    expect(stripFences(input)).toBe(input.trim());
  });
});
