import { describe, expect, test } from "bun:test";
import {
  API_PROVIDERS,
  CLI_PROVIDERS,
  getRegistration,
  isCliProvider,
  isKnownProvider,
  providerNeedsApiKey,
  validateProviderEntry,
} from "../src/llm/providers/registry.ts";

describe("API_PROVIDERS / CLI_PROVIDERS registry", () => {
  test("declared key order doubles as wizard display order", () => {
    // The wizard relies on this order for Screen 1 rendering.
    expect(Object.keys(API_PROVIDERS)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "groq",
      "mistral",
      "ollama",
    ]);
  });

  test("API providers carry wizard metadata (displayName + kind)", () => {
    for (const [name, provider] of Object.entries(API_PROVIDERS)) {
      expect(provider.displayName).toBeTruthy();
      expect(provider.kind).toBeTruthy();
      // apiKeyUrl is optional (ollama has none).
      if (name !== "ollama") expect(provider.apiKeyUrl).toBeTruthy();
    }
  });

  test("claude-code is the only v1 CLI provider", () => {
    expect(Object.keys(CLI_PROVIDERS)).toEqual(["claude-code"]);
    expect(CLI_PROVIDERS["claude-code"]?.probeCmd).toBe("claude");
  });

  test("anthropic and openai recommended regexes match expected flagships", () => {
    expect(API_PROVIDERS.anthropic?.recommendedModelRegex?.test("claude-sonnet-4-6")).toBe(true);
    expect(API_PROVIDERS.anthropic?.recommendedModelRegex?.test("claude-haiku-4-5")).toBe(false);
    expect(API_PROVIDERS.openai?.recommendedModelRegex?.test("gpt-5")).toBe(true);
    expect(API_PROVIDERS.openai?.recommendedModelRegex?.test("gpt-5.1")).toBe(true);
    expect(API_PROVIDERS.openai?.recommendedModelRegex?.test("gpt-4")).toBe(false);
  });
});

describe("isKnownProvider", () => {
  test("returns true for API providers", () => {
    expect(isKnownProvider("anthropic")).toBe(true);
    expect(isKnownProvider("ollama")).toBe(true);
    expect(isKnownProvider("openrouter")).toBe(true);
  });

  test("returns true for CLI providers", () => {
    expect(isKnownProvider("claude-code")).toBe(true);
  });

  test("returns false for unknown names", () => {
    expect(isKnownProvider("custom")).toBe(false);
    expect(isKnownProvider("")).toBe(false);
  });
});

describe("isCliProvider", () => {
  test("true for CLI providers", () => {
    expect(isCliProvider("claude-code")).toBe(true);
  });

  test("false for API providers and unknowns", () => {
    expect(isCliProvider("anthropic")).toBe(false);
    expect(isCliProvider("ollama")).toBe(false);
    expect(isCliProvider("custom")).toBe(false);
  });
});

describe("providerNeedsApiKey", () => {
  test("true for API providers with apiKeyUrl", () => {
    expect(providerNeedsApiKey("anthropic")).toBe(true);
    expect(providerNeedsApiKey("openai")).toBe(true);
    expect(providerNeedsApiKey("openrouter")).toBe(true);
  });

  test("false for ollama (no apiKeyUrl) and CLI providers", () => {
    expect(providerNeedsApiKey("ollama")).toBe(false);
    expect(providerNeedsApiKey("claude-code")).toBe(false);
  });

  test("false for unknown providers", () => {
    expect(providerNeedsApiKey("custom")).toBe(false);
  });
});

describe("getRegistration", () => {
  test("returns the API provider kind", () => {
    expect(getRegistration("anthropic").kind).toBe("anthropic");
    expect(getRegistration("openai").kind).toBe("openai");
    expect(getRegistration("ollama").kind).toBe("openai-compat");
  });

  test("returns the CLI provider kind", () => {
    expect(getRegistration("claude-code").kind).toBe("claude-code");
  });

  test("defaults unknown names to openai-compat", () => {
    expect(getRegistration("somebody").kind).toBe("openai-compat");
  });

  test("supportsStructuredOutputs is true for strict-capable providers", () => {
    expect(getRegistration("openai").supportsStructuredOutputs).toBe(true);
    expect(getRegistration("groq").supportsStructuredOutputs).toBe(true);
    expect(getRegistration("mistral").supportsStructuredOutputs).toBe(true);
  });

  test("supportsStructuredOutputs is false/undefined for non-strict providers", () => {
    expect(getRegistration("openrouter").supportsStructuredOutputs).toBeFalsy();
    expect(getRegistration("ollama").supportsStructuredOutputs).toBeFalsy();
    expect(getRegistration("somebody").supportsStructuredOutputs).toBeFalsy();
  });
});

describe("validateProviderEntry", () => {
  test("openrouter without baseURL → error", () => {
    expect(validateProviderEntry("openrouter", { apiKey: "x", model: "y" })).toMatch(
      /requires baseURL/,
    );
  });

  test("groq without baseURL → error", () => {
    expect(validateProviderEntry("groq", { apiKey: "x", model: "y" })).toMatch(/requires baseURL/);
  });

  test("mistral without baseURL → error", () => {
    expect(validateProviderEntry("mistral", { apiKey: "x", model: "y" })).toMatch(
      /requires baseURL/,
    );
  });

  test("ollama without baseURL → error", () => {
    expect(validateProviderEntry("ollama", { model: "llama" })).toMatch(/requires baseURL/);
  });

  test("anthropic with just a model → ok", () => {
    expect(validateProviderEntry("anthropic", { model: "claude-sonnet-4-6" })).toBeNull();
  });

  test("openai with just an apiKey + model → ok", () => {
    expect(validateProviderEntry("openai", { apiKey: "sk-proj-x", model: "gpt-5" })).toBeNull();
  });

  test("unknown provider missing fields → generic error", () => {
    expect(validateProviderEntry("custom", { model: "x" })).toMatch(
      /requires baseURL, apiKey, and model/,
    );
  });

  test("unknown provider with all three fields → ok", () => {
    expect(
      validateProviderEntry("custom", {
        baseURL: "https://api.example.com/v1",
        apiKey: "x",
        model: "y",
      }),
    ).toBeNull();
  });
});
