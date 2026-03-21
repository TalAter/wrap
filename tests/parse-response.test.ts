import { describe, expect, test } from "bun:test";
import { parseResponse } from "../src/core/parse-response.ts";

describe("parseResponse", () => {
  test("parses valid command response", () => {
    const raw = JSON.stringify({
      type: "command",
      command: "ls -la",
      risk_level: "low",
    });
    const result = parseResponse(raw);
    expect(result.type).toBe("command");
    expect(result.command).toBe("ls -la");
    expect(result.risk_level).toBe("low");
  });

  test("parses valid answer response", () => {
    const raw = JSON.stringify({
      type: "answer",
      answer: "42",
      risk_level: "low",
    });
    const result = parseResponse(raw);
    expect(result.type).toBe("answer");
    expect(result.answer).toBe("42");
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
      command: "echo test",
      risk_level: "low",
      memory_updates: [{ key: "shell", value: "zsh" }],
      memory_updates_message: "Noted: you use zsh",
    });
    const result = parseResponse(raw);
    expect(result.memory_updates).toHaveLength(1);
    expect(result.memory_updates_message).toBe("Noted: you use zsh");
  });
});
