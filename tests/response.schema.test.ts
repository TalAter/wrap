import { describe, expect, test } from "bun:test";
import { ResponseSchema } from "../src/response.schema.ts";

describe("ResponseSchema", () => {
  test("parses valid command response", () => {
    const input = {
      type: "command",
      command: "find . -name '*.ts' -mtime 0",
      risk_level: "low",
      explanation: "Find TypeScript files modified today",
    };
    const result = ResponseSchema.parse(input);
    expect(result.type).toBe("command");
    expect(result.command).toBe("find . -name '*.ts' -mtime 0");
    expect(result.risk_level).toBe("low");
    expect(result.explanation).toBe("Find TypeScript files modified today");
  });

  test("parses valid answer response", () => {
    const input = {
      type: "answer",
      answer: "The speed of light is approximately 299,792,458 m/s",
      risk_level: "low",
    };
    const result = ResponseSchema.parse(input);
    expect(result.type).toBe("answer");
    expect(result.answer).toBe("The speed of light is approximately 299,792,458 m/s");
  });

  test("parses valid probe response", () => {
    const input = {
      type: "probe",
      command: "echo $SHELL",
      risk_level: "low",
      explanation: "Checking which shell you use",
    };
    const result = ResponseSchema.parse(input);
    expect(result.type).toBe("probe");
    expect(result.command).toBe("echo $SHELL");
  });

  test("parses response with memory_updates", () => {
    const input = {
      type: "command",
      command: "echo 'alias ll=ls -la' >> ~/.zshrc",
      risk_level: "medium",
      memory_updates: [{ fact: "Default shell is zsh" }, { fact: "Shell config at ~/.zshrc" }],
      memory_updates_message: "Noted: you use zsh, config at ~/.zshrc",
    };
    const result = ResponseSchema.parse(input);
    expect(result.memory_updates).toHaveLength(2);
    expect(result.memory_updates?.[0]).toEqual({ fact: "Default shell is zsh" });
    expect(result.memory_updates_message).toBe("Noted: you use zsh, config at ~/.zshrc");
  });

  test("rejects invalid type", () => {
    const input = { type: "invalid", risk_level: "low" };
    expect(() => ResponseSchema.parse(input)).toThrow();
  });

  test("rejects invalid risk_level", () => {
    const input = { type: "command", command: "ls", risk_level: "extreme" };
    expect(() => ResponseSchema.parse(input)).toThrow();
  });

  test("requires type field", () => {
    const input = { command: "ls", risk_level: "low" };
    expect(() => ResponseSchema.parse(input)).toThrow();
  });

  test("requires risk_level", () => {
    let input: Record<string, unknown> = { type: "command", command: "ls" };
    expect(() => ResponseSchema.parse(input)).toThrow();
    input = { ...input, risk_level: "low" };
    expect(() => ResponseSchema.parse(input)).not.toThrow();
  });

  test("allows optional fields to be omitted", () => {
    const input = { type: "command", risk_level: "low" };
    const result = ResponseSchema.parse(input);
    expect(result.command).toBeUndefined();
    expect(result.answer).toBeUndefined();
    expect(result.explanation).toBeUndefined();
    expect(result.memory_updates).toBeUndefined();
    expect(result.memory_updates_message).toBeUndefined();
  });

  test("allows empty memory_updates array", () => {
    const input = { type: "command", risk_level: "low", memory_updates: [] };
    const result = ResponseSchema.parse(input);
    expect(result.memory_updates).toEqual([]);
  });

  test("rejects memory_updates entry with missing fact", () => {
    const input = {
      type: "command",
      risk_level: "low",
      memory_updates: [{ key: "shell", value: "zsh" }],
    };
    expect(() => ResponseSchema.parse(input)).toThrow();
  });
});
