// Legacy provider machinery (src/llm/{index,types,providers}) — off the
// runtime path since the main-loop flip onto wrap-core/llm. These tests
// keep the parked code honest until Unit 7 deletes it together with them.
import { describe, expect, test } from "bun:test";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
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
const OPENROUTER_RESOLVED: ResolvedProvider = {
  name: "openrouter",
  model: "anthropic/claude-3.5-sonnet",
};
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

  test("returns a provider for openrouter", () => {
    const provider = initProvider(OPENROUTER_RESOLVED);
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

  test("non-test names do not route to the test provider", () => {
    // The `name === "test"` guard is the only thing keeping non-test entries
    // from short-circuiting to testProvider. testProvider accepts any
    // ResolvedProvider; ai-sdk factories reject entries without a model.
    expect(() => initProvider({ name: "anthropic" })).toThrow();
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
    // The echo-the-last-user-message fallback pin died at the main-loop
    // flip: it existed only for the schemaless path the always-structured
    // core abolishes — no-responses-configured is now a config error at
    // createLlm (pinned in llm-config.test.ts).

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
