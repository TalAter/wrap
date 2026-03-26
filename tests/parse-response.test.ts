import { describe, expect, test } from "bun:test";
import { parseResponse, stripFences } from "../src/core/parse-response.ts";

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
    const input = '```json\n{\n  "type": "command",\n  "content": "ls"\n}\n```';
    expect(stripFences(input)).toBe('{\n  "type": "command",\n  "content": "ls"\n}');
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

describe("parseResponse with fenced input", () => {
  test("parses valid JSON wrapped in ```json fences", () => {
    const raw = '```json\n{"type":"command","content":"ls","risk_level":"low"}\n```';
    const result = parseResponse(raw);
    expect(result.type).toBe("command");
    expect(result.content).toBe("ls");
  });

  test("parses valid JSON wrapped in bare ``` fences", () => {
    const raw = '```\n{"type":"answer","content":"42","risk_level":"low"}\n```';
    const result = parseResponse(raw);
    expect(result.type).toBe("answer");
    expect(result.content).toBe("42");
  });

  test("throws on multiple fenced blocks (not stripped)", () => {
    const raw = '```json\n{"type":"command"}\n```\n\n```\nmore\n```';
    expect(() => parseResponse(raw)).toThrow("invalid JSON");
  });
});

describe("parseResponse", () => {
  test("parses valid command response", () => {
    const raw = JSON.stringify({
      type: "command",
      content: "ls -la",
      risk_level: "low",
    });
    const result = parseResponse(raw);
    expect(result.type).toBe("command");
    expect(result.content).toBe("ls -la");
    expect(result.risk_level).toBe("low");
  });

  test("parses valid answer response", () => {
    const raw = JSON.stringify({
      type: "answer",
      content: "42",
      risk_level: "low",
    });
    const result = parseResponse(raw);
    expect(result.type).toBe("answer");
    expect(result.content).toBe("42");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseResponse("not json")).toThrow("invalid JSON");
  });

  test("throws on schema validation failure", () => {
    const raw = JSON.stringify({ type: "command" }); // missing risk_level
    expect(() => parseResponse(raw)).toThrow("invalid response");
  });

  test("parses response with memory_updates", () => {
    const raw = JSON.stringify({
      type: "command",
      content: "echo test",
      risk_level: "low",
      memory_updates: [{ fact: "Default shell is zsh", scope: "/" }],
      memory_updates_message: "Noted: you use zsh",
    });
    const result = parseResponse(raw);
    expect(result.memory_updates).toHaveLength(1);
    expect(result.memory_updates_message).toBe("Noted: you use zsh");
  });
});
