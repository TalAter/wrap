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

  test("parses valid reply response", () => {
    const input = {
      type: "reply",
      content: "The speed of light is approximately 299,792,458 m/s",
      risk_level: "low",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.type).toBe("reply");
    expect(result.content).toBe("The speed of light is approximately 299,792,458 m/s");
  });

  test("rejects legacy 'answer' type", () => {
    const input = {
      type: "answer",
      content: "hi",
      risk_level: "low",
    };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("rejects legacy 'probe' type", () => {
    const input = {
      type: "probe",
      content: "echo $SHELL",
      risk_level: "low",
    };
    expect(() => CommandResponseSchema.parse(input)).toThrow();
  });

  test("parses non-final command as a step", () => {
    const input = {
      type: "command",
      content: "curl -fsSL https://example.com/installer.sh -o $WRAP_TEMP_DIR/installer.sh",
      risk_level: "low",
      final: false,
      plan: "Download, then inspect, then run from the temp dir.",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.type).toBe("command");
    expect(result.final).toBe(false);
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

  test("accepts every documented risk_level (low, medium, high)", () => {
    for (const risk_level of ["low", "medium", "high"] as const) {
      const input = { type: "command", content: "rm -rf /tmp/x", risk_level };
      const result = CommandResponseSchema.parse(input);
      expect(result.risk_level).toBe(risk_level);
    }
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
      type: "command",
      content: "which sips convert magick",
      risk_level: "low",
      final: false,
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

  test("ignores stray pipe_stdin field from old LLM responses", () => {
    // Field was removed from the schema (input is now read via shell
    // redirection from $WRAP_TEMP_DIR/input). Old responses that still carry
    // it must parse cleanly rather than blowing up.
    const input = {
      type: "command",
      content: "wc -l",
      risk_level: "low",
      pipe_stdin: true,
    };
    const result = CommandResponseSchema.parse(input);
    expect("pipe_stdin" in result).toBe(false);
  });

  test("final defaults to true when omitted", () => {
    const input = { type: "command", content: "ls", risk_level: "low" };
    const result = CommandResponseSchema.parse(input);
    expect(result.final).toBe(true);
  });

  test("parses non-final command with plan", () => {
    const input = {
      type: "command",
      content: "curl -fsSL https://example.com/installer.sh -o $WRAP_TEMP_DIR/installer.sh",
      risk_level: "low",
      final: false,
      plan: "Download the installer, inspect it, then run the exact bytes we inspected.",
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.final).toBe(false);
    expect(result.plan).toBe(
      "Download the installer, inspect it, then run the exact bytes we inspected.",
    );
  });

  test("allows plan to be null or omitted", () => {
    const base = { type: "command", content: "ls", risk_level: "low", final: false };
    expect(CommandResponseSchema.parse(base).plan).toBeUndefined();
    expect(CommandResponseSchema.parse({ ...base, plan: null }).plan).toBeNull();
  });

  test("reply with explicit final: true round-trips", () => {
    const input = {
      type: "reply",
      content: "42",
      risk_level: "low",
      final: true,
    };
    const result = CommandResponseSchema.parse(input);
    expect(result.type).toBe("reply");
    expect(result.final).toBe(true);
  });
});
