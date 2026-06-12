import { describe, expect, test } from "bun:test";
import { buildLlmConfig, initLlm } from "../src/llm/llm-config.ts";
import type { ResolvedProvider } from "../src/llm/types.ts";

const RESOLVED: ResolvedProvider = {
  name: "anthropic",
  model: "claude-sonnet-4-5",
  apiKey: "sk-test-key",
};

describe("buildLlmConfig", () => {
  test("WRAP_TEST_RESPONSES (JSON array) → test config with parsed responses", () => {
    const responses = [{ facts: ["macOS"] }, "second"];
    const config = buildLlmConfig(RESOLVED, {
      WRAP_TEST_RESPONSES: JSON.stringify(responses),
    });
    expect(config).toEqual({ name: "test", responses });
  });

  test("WRAP_TEST_RESPONSES wins over WRAP_TEST_RESPONSE", () => {
    const config = buildLlmConfig(RESOLVED, {
      WRAP_TEST_RESPONSES: '["from list"]',
      WRAP_TEST_RESPONSE: "from single",
    });
    expect(config).toEqual({ name: "test", responses: ["from list"] });
  });

  test("empty WRAP_TEST_RESPONSES falls through to WRAP_TEST_RESPONSE", () => {
    // Mirrors the legacy test provider's truthy check on WRAP_TEST_RESPONSES.
    const config = buildLlmConfig(RESOLVED, {
      WRAP_TEST_RESPONSES: "",
      WRAP_TEST_RESPONSE: "single",
    });
    expect(config).toEqual({ name: "test", responses: "single" });
  });

  test("WRAP_TEST_RESPONSE is taken verbatim, not JSON-parsed", () => {
    const raw = "not json {{{";
    const config = buildLlmConfig(RESOLVED, { WRAP_TEST_RESPONSE: raw });
    expect(config).toEqual({ name: "test", responses: raw });
  });

  test("invalid WRAP_TEST_RESPONSES JSON → Config error", () => {
    expect(() => buildLlmConfig(RESOLVED, { WRAP_TEST_RESPONSES: "{broken" })).toThrow(
      "Config error: WRAP_TEST_RESPONSES contains invalid JSON.",
    );
  });

  test("no test env → real provider config from ResolvedProvider", () => {
    const config = buildLlmConfig(RESOLVED, {});
    expect(config).toEqual({
      name: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "sk-test-key",
    });
  });

  test("absent ResolvedProvider fields stay absent on the config", () => {
    const config = buildLlmConfig({ name: "claude-code" }, {});
    expect(config).toEqual({ name: "claude-code" });
    expect("model" in config).toBe(false);
    expect("apiKey" in config).toBe(false);
    expect("baseURL" in config).toBe(false);
  });

  test("baseURL passes through for endpoint providers", () => {
    const config = buildLlmConfig(
      { name: "ollama", model: "llama3.2", baseURL: "http://localhost:11434/v1" },
      {},
    );
    expect(config).toEqual({
      name: "ollama",
      model: "llama3.2",
      baseURL: "http://localhost:11434/v1",
    });
  });
});

describe("initLlm", () => {
  test("core config errors surface with wrap's Config error prefix", () => {
    // An empty responses list is a config error at createLlm (core); wrap's
    // voice prefix is applied at this surfacing site.
    expect(() => initLlm(RESOLVED, { WRAP_TEST_RESPONSES: "[]" })).toThrow(/^Config error: /);
  });
});
