import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
import { buildWireRequest, resolveApiKey } from "../src/llm/providers/ai-sdk.ts";

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

describe("buildWireRequest", () => {
  test("strips system and messages, keeps SDK-added delta", () => {
    const raw = {
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: [{ text: "You are wrap", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "response" },
      tools: [{ name: "response", input_schema: {} }],
    };
    const wire = buildWireRequest(raw);
    expect(wire).toBeDefined();
    if (!wire) throw new Error("wire missing");
    expect(wire.kind).toBe("http");
    if (wire.kind !== "http") throw new Error("kind");
    const body = wire.body as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(8192);
    expect(body.tools).toBeDefined();
    expect("system" in body).toBe(false);
    expect("messages" in body).toBe(false);
  });

  test("returns undefined for absent body", () => {
    expect(buildWireRequest(undefined)).toBeUndefined();
    expect(buildWireRequest(null)).toBeUndefined();
  });

  test("returns undefined for non-object body", () => {
    expect(buildWireRequest("some string")).toBeUndefined();
    expect(buildWireRequest(42)).toBeUndefined();
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
