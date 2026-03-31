import { describe, expect, test } from "bun:test";
import { CommandResponseSchema } from "../src/command-response.schema.ts";

describe("CommandResponseSchema", () => {
  test("parses valid command response", () => {
    const input = {
      type: "command",
      content: "find . -name '*.ts' -mtime 0",
      risk_level: "low",
      explanation: "Find TypeScript files modified today",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.type).toBe("command");
    expect(result.content).toBe("find . -name '*.ts' -mtime 0");
    expect(result.risk_level).toBe("low");
    expect(result.explanation).toBe("Find TypeScript files modified today");
  });

  test("parses valid answer response", () => {
    const input = {
      type: "answer",
      content: "The speed of light is approximately 299,792,458 m/s",
      risk_level: "low",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.type).toBe("answer");
    expect(result.content).toBe("The speed of light is approximately 299,792,458 m/s");
  });

  test("parses valid probe response", () => {
    const input = {
      type: "probe",
      content: "echo $SHELL",
      risk_level: "low",
      explanation: "Checking which shell you use",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.type).toBe("probe");
    expect(result.content).toBe("echo $SHELL");
  });

  test("parses response with memory_updates including scope", () => {
    const input = {
      type: "command",
      content: "echo 'alias ll=ls -la' >> ~/.zshrc",
      risk_level: "medium",
      memory_updates: [
        { fact: "Default shell is zsh", scope: "/" },
        { fact: "Uses bun", scope: "/Users/tal/project" },
      ],
      memory_updates_message: "Noted: you use zsh; this project uses bun",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.memory_updates).toHaveLength(2);
    expect(result.memory_updates?.[0]).toEqual({ fact: "Default shell is zsh", scope: "/" });
    expect(result.memory_updates?.[1]?.scope).toBe("/Users/tal/project");
    expect(result.memory_updates_message).toBe("Noted: you use zsh; this project uses bun");
  });

  test("requires scope field in memory_updates entries", () => {
    const input = {
      type: "command",
      content: "ls",
      risk_level: "low",
      memory_updates: [{ fact: "Uses zsh" }],
    };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("rejects invalid type", () => {
    const input = { type: "invalid", risk_level: "low" };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("rejects invalid risk_level", () => {
    const input = { type: "command", content: "ls", risk_level: "extreme" };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("requires type field", () => {
    const input = { content: "ls", risk_level: "low" };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("requires risk_level", () => {
    let input: Record<string, unknown> = { type: "command", content: "ls" };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
    input = { ...input, risk_level: "low" };
    expect(() => CommandResponseSchema.parse(input)).not.toThrow();
  });

  test("requires content field", () => {
    const input = { type: "command", risk_level: "low" };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("allows optional fields to be omitted", () => {
    const input = { type: "command", content: "ls", risk_level: "low" };
    const result = CommandResponseSchema.parse(input);
    expect(result.explanation).toBeUndefined();
    expect(result.memory_updates).toBeUndefined();
    expect(result.memory_updates_message).toBeUndefined();
  });

  test("allows nullable fields to be null", () => {
    const input = {
      type: "command",
      content: "ls",
      risk_level: "low",
      explanation: null,
      memory_updates: null,
      memory_updates_message: null,
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.explanation).toBeNull();
    expect(result.memory_updates).toBeNull();
  });

  test("allows empty memory_updates array", () => {
    const input = { type: "command", content: "ls", risk_level: "low", memory_updates: [] };
    const result = CommandResponseSchema.parse(input);
    expect(result.memory_updates).toEqual([]);
  });

  test("rejects memory_updates entry with missing fact", () => {
    const input = {
      type: "command",
      content: "ls",
      risk_level: "low",
      memory_updates: [{ key: "shell", value: "zsh" }],
    };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("parses response with watchlist_additions", () => {
    const input = {
      type: "probe",
      content: "which sips convert magick",
      risk_level: "low",
      watchlist_additions: ["sips", "convert", "magick"],
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.watchlist_additions).toEqual(["sips", "convert", "magick"]);
  });

  test("allows watchlist_additions to be null or omitted", () => {
    const base = { type: "command", content: "ls", risk_level: "low" };
    expect(CommandResponseSchema.parse(base).watchlist_additions).toBeUndefined();
    expect(
      CommandResponseSchema.parse({ ...base, watchlist_additions: null }).watchlist_additions,
    ).toBeNull();
  });

  test("allows empty watchlist_additions array", () => {
    const input = { type: "command", content: "ls", risk_level: "low", watchlist_additions: [] };
    expect(CommandResponseSchema.parse(input).watchlist_additions).toEqual([]);
  });
});
