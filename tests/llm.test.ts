import { describe, expect, test } from "bun:test";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
import { StructuredOutputError } from "../src/core/parse-response.ts";
import { isStructuredOutputError } from "../src/core/round.ts";
import { initProvider, runCommandPrompt } from "../src/llm/index.ts";
import { TEST_RESOLVED_PROVIDER, testProvider } from "../src/llm/providers/test.ts";
import type { PromptInput, ResolvedProvider } from "../src/llm/types.ts";

const input: PromptInput = {
  system: "you are a test",
  messages: [{ role: "user", content: "hello world" }],
};

const ANTHROPIC_RESOLVED: ResolvedProvider = {
  name: "anthropic",
  model: "claude-haiku-4-5",
};
const OPENAI_RESOLVED: ResolvedProvider = { name: "openai", model: "gpt-4o-mini" };
const CLAUDE_CODE_RESOLVED: ResolvedProvider = {
  name: "claude-code",
  model: "haiku",
};

describe("initProvider factory", () => {
  test("returns a provider for the test sentinel", () => {
    const provider = initProvider(TEST_RESOLVED_PROVIDER);
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for claude-code", () => {
    const provider = initProvider(CLAUDE_CODE_RESOLVED);
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for anthropic", () => {
    const provider = initProvider(ANTHROPIC_RESOLVED);
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for openai", () => {
    const provider = initProvider(OPENAI_RESOLVED);
    expect(typeof provider.runPrompt).toBe("function");
  });

  test("returns a provider for unknown openai-compat (e.g. groq)", () => {
    const provider = initProvider({
      name: "groq",
      model: "llama-3.1-70b-versatile",
      apiKey: "gsk_x",
      baseURL: "https://api.groq.com/openai/v1",
    });
    expect(typeof provider.runPrompt).toBe("function");
  });
});

describe("testProvider error simulation", () => {
  test("throws when WRAP_TEST_RESPONSE starts with ERROR:", async () => {
    const prev = process.env.WRAP_TEST_RESPONSE;
    try {
      process.env.WRAP_TEST_RESPONSE = "ERROR:simulated LLM failure";
      const provider = testProvider();
      await expect(provider.runPrompt(input)).rejects.toThrow("simulated LLM failure");
    } finally {
      if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
      else process.env.WRAP_TEST_RESPONSE = prev;
    }
  });
});

describe("testProvider", () => {
  describe("runPrompt (no schema)", () => {
    test("returns last user message content", async () => {
      const provider = testProvider();
      const result = await provider.runPrompt(input);
      expect(result).toBe("hello world");
    });

    test("returns WRAP_TEST_RESPONSE when set", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = "custom response";
        const provider = testProvider();
        const result = await provider.runPrompt(input);
        expect(result).toBe("custom response");
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });
  });

  describe("runPrompt (with schema)", () => {
    test("parses and validates JSON against schema", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = JSON.stringify({
          type: "command",
          content: "echo hi",
          risk_level: "low",
        });
        const provider = testProvider();
        const result = await provider.runPrompt(input, CommandResponseSchema);
        expect(result).toEqual({
          type: "command",
          content: "echo hi",
          risk_level: "low",
          final: true,
        });
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });

    test("throws on schema validation failure", async () => {
      const prev = process.env.WRAP_TEST_RESPONSE;
      try {
        process.env.WRAP_TEST_RESPONSE = JSON.stringify({ bad: "data" });
        const provider = testProvider();
        expect(provider.runPrompt(input, CommandResponseSchema)).rejects.toThrow();
      } finally {
        if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
        else process.env.WRAP_TEST_RESPONSE = prev;
      }
    });
  });
});

describe("runCommandPrompt", () => {
  test("returns typed CommandResponse via test provider", async () => {
    const prev = process.env.WRAP_TEST_RESPONSE;
    try {
      process.env.WRAP_TEST_RESPONSE = JSON.stringify({
        type: "command",
        content: "ls",
        risk_level: "low",
      });
      const provider = testProvider();
      const result = await runCommandPrompt(provider, input);
      expect(result.type).toBe("command");
      expect(result.content).toBe("ls");
    } finally {
      if (prev === undefined) delete process.env.WRAP_TEST_RESPONSE;
      else process.env.WRAP_TEST_RESPONSE = prev;
    }
  });
});

describe("claudeCodeProvider", () => {
  test("throws retryable StructuredOutputError on invalid schema", async () => {
    // Simulate what claudeCodeProvider does after spawnAndRead returns:
    // stripFences → JSON.parse → safeParse. When the schema fails, the thrown
    // error must be a StructuredOutputError recognised by isStructuredOutputError
    // so callWithRetry can retry with the raw text.
    const { stripFences } = await import("../src/core/parse-response.ts");
    const raw = JSON.stringify({
      type: "command",
      content: "git diff main",
      risk_level: "none", // invalid enum
    });
    const cleaned = stripFences(raw);
    const json = JSON.parse(cleaned);
    const result = CommandResponseSchema.safeParse(json);
    expect(result.success).toBe(false);

    // This is what claude-code.ts now throws:
    const err = new StructuredOutputError("LLM returned an invalid response.", cleaned);
    expect(isStructuredOutputError(err)).toBe(true);
    expect(err.text).toBe(raw);
  });
});
