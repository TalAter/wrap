import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
import { resolveApiKey } from "../src/llm/providers/ai-sdk.ts";

describe("resolveApiKey", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function deleteEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  test("returns undefined when value is undefined", () => {
    expect(resolveApiKey(undefined)).toBeUndefined();
  });

  test("resolves $ENV_VAR from environment", () => {
    setEnv("MY_TEST_KEY", "sk-secret");
    expect(resolveApiKey("$MY_TEST_KEY")).toBe("sk-secret");
  });

  test("throws when $ENV_VAR is not set", () => {
    deleteEnv("NONEXISTENT_KEY_12345");
    expect(() => resolveApiKey("$NONEXISTENT_KEY_12345")).toThrow(
      "Config error: environment variable NONEXISTENT_KEY_12345 is not set.",
    );
  });

  test("returns literal string as-is", () => {
    expect(resolveApiKey("sk-literal-key")).toBe("sk-literal-key");
  });
});

describe("OpenAI strict schema round-trip", () => {
  test("CommandResponseSchema JSON schema has all properties in required after strictify", () => {
    // Simulate what toOpenAIStrictSchema does
    const raw = structuredClone(z.toJSONSchema(CommandResponseSchema)) as Record<string, unknown>;
    const props = raw.properties as Record<string, unknown>;
    const allKeys = Object.keys(props);
    // Before: type, content, and risk_level are required
    expect(raw.required).toContain("type");
    expect(raw.required).toContain("content");
    expect(raw.required).toContain("risk_level");
    // After addAllToRequired: all keys including nullable optional fields
    raw.required = allKeys;
    expect(raw.required).toContain("memory_updates");
  });

  test("nullable fields produce anyOf with null in JSON schema", () => {
    const raw = z.toJSONSchema(CommandResponseSchema) as Record<string, unknown>;
    const props = raw.properties as Record<string, Record<string, unknown>>;
    // explanation is nullable().optional() → anyOf: [string, null]
    const explanation = props.explanation;
    if (!explanation) throw new Error("expected explanation in schema properties");
    expect(explanation.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    // content is required string → just {type: "string"}
    expect(props.content).toEqual({ type: "string" });
  });

  test("Zod validates OpenAI-style response with nulls", () => {
    const openaiResponse = {
      type: "command",
      content: "ls -la",
      risk_level: "low",
      explanation: null,
      memory_updates: null,
      memory_updates_message: null,
    };
    const result = CommandResponseSchema.safeParse(openaiResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe("ls -la");
    }
  });

  test("Zod validates response with omitted optional fields", () => {
    const response = {
      type: "command",
      content: "ls -la",
      risk_level: "low",
    };
    const result = CommandResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });
});
