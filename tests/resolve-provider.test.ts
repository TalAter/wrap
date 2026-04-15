import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config/config.ts";
import { parseModelOverride, resolveProvider } from "../src/llm/resolve-provider.ts";

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("resolveProvider — test sentinel", () => {
  test("WRAP_TEST_RESPONSE set returns test sentinel regardless of config", () => {
    const result = resolveProvider({}, { WRAP_TEST_RESPONSE: "{}" });
    expect(result).toEqual({ name: "test", model: "test" });
  });

  test("WRAP_TEST_RESPONSE empty string still triggers sentinel (env present)", () => {
    const result = resolveProvider({}, { WRAP_TEST_RESPONSE: "" });
    expect(result).toEqual({ name: "test", model: "test" });
  });

  test("WRAP_TEST_RESPONSES (array variant) also triggers sentinel", () => {
    const result = resolveProvider({}, { WRAP_TEST_RESPONSES: "[]" });
    expect(result).toEqual({ name: "test", model: "test" });
  });

  test("sentinel ignores config state", () => {
    const config: Config = {
      providers: { anthropic: { apiKey: "k", model: "claude" } },
      defaultProvider: "anthropic",
    };
    const result = resolveProvider(config, { WRAP_TEST_RESPONSE: "x" });
    expect(result).toEqual({ name: "test", model: "test" });
  });
});

describe("resolveProvider — defaultProvider path", () => {
  test("returns resolved entry from defaultProvider", () => {
    const config: Config = {
      providers: {
        anthropic: { apiKey: "sk-x", model: "claude-haiku-4-5" },
      },
      defaultProvider: "anthropic",
    };
    expect(resolveProvider(config, EMPTY_ENV)).toEqual({
      name: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "sk-x",
      baseURL: undefined,
    });
  });

  test("preserves baseURL on resolved entry", () => {
    const config: Config = {
      providers: {
        ollama: { baseURL: "http://localhost:11434/v1", model: "llama3.2" },
      },
      defaultProvider: "ollama",
    };
    const result = resolveProvider(config, EMPTY_ENV);
    expect(result.baseURL).toBe("http://localhost:11434/v1");
    expect(result.model).toBe("llama3.2");
  });

  test("missing providers map → generic config error", () => {
    expect(() => resolveProvider({}, EMPTY_ENV)).toThrow(
      "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.",
    );
  });

  test("empty providers map with defaultProvider unset → generic config error", () => {
    expect(() => resolveProvider({ providers: {} }, EMPTY_ENV)).toThrow(
      "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.",
    );
  });

  test("empty providers map with defaultProvider named → specific not-found error", () => {
    // defaultProvider points at something that isn't in providers.
    expect(() =>
      resolveProvider({ providers: {}, defaultProvider: "anthropic" }, EMPTY_ENV),
    ).toThrow('Config error: provider "anthropic" not found in config.');
  });

  test("defaultProvider unset → generic config error", () => {
    expect(() =>
      resolveProvider({ providers: { anthropic: { apiKey: "k", model: "m" } } }, EMPTY_ENV),
    ).toThrow("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.");
  });

  test("defaultProvider names a provider not in providers → specific not-found error", () => {
    expect(() =>
      resolveProvider(
        {
          providers: { anthropic: { apiKey: "k", model: "m" } },
          defaultProvider: "openai",
        },
        EMPTY_ENV,
      ),
    ).toThrow('Config error: provider "openai" not found in config.');
  });

  test("resolved entry has no model → specific no-model error", () => {
    expect(() =>
      resolveProvider(
        {
          providers: { anthropic: { apiKey: "k" } },
          defaultProvider: "anthropic",
        },
        EMPTY_ENV,
      ),
    ).toThrow('Config error: provider "anthropic" has no model set in config.');
  });
});

describe("resolveProvider — per-entry validation", () => {
  test("ollama without baseURL → ollama error", () => {
    const config: Config = {
      providers: { ollama: { model: "llama3.2" } },
      defaultProvider: "ollama",
    };
    expect(() => resolveProvider(config, EMPTY_ENV)).toThrow(
      'Config error: provider "ollama" requires baseURL.',
    );
  });

  test("ollama with baseURL → valid", () => {
    const config: Config = {
      providers: { ollama: { baseURL: "http://localhost:11434/v1", model: "llama3.2" } },
      defaultProvider: "ollama",
    };
    const result = resolveProvider(config, EMPTY_ENV);
    expect(result.name).toBe("ollama");
  });

  test("unknown provider with all required fields → valid", () => {
    const config: Config = {
      providers: {
        custom: {
          baseURL: "https://api.custom.com/openai/v1",
          apiKey: "gsk_x",
          model: "llama-3.1-70b-versatile",
        },
      },
      defaultProvider: "custom",
    };
    const result = resolveProvider(config, EMPTY_ENV);
    expect(result).toEqual({
      name: "custom",
      model: "llama-3.1-70b-versatile",
      apiKey: "gsk_x",
      baseURL: "https://api.custom.com/openai/v1",
    });
  });

  test("unknown provider missing apiKey → error", () => {
    const config: Config = {
      providers: {
        custom: { baseURL: "https://api.custom.com/openai/v1", model: "llama" },
      },
      defaultProvider: "custom",
    };
    expect(() => resolveProvider(config, EMPTY_ENV)).toThrow(
      'Config error: provider "custom" requires baseURL, apiKey, and model.',
    );
  });

  test("unknown provider missing baseURL → error", () => {
    const config: Config = {
      providers: { custom: { apiKey: "gsk_x", model: "llama" } },
      defaultProvider: "custom",
    };
    expect(() => resolveProvider(config, EMPTY_ENV)).toThrow(
      'Config error: provider "custom" requires baseURL, apiKey, and model.',
    );
  });

  test("unknown provider missing both apiKey and model → entry validator wins", () => {
    const config: Config = {
      providers: { custom: { baseURL: "https://api.custom.com/openai/v1" } },
      defaultProvider: "custom",
    };
    expect(() => resolveProvider(config, EMPTY_ENV)).toThrow(
      'Config error: provider "custom" requires baseURL, apiKey, and model.',
    );
  });

  test("ollama missing both baseURL and model → baseURL error wins", () => {
    const config: Config = {
      providers: { ollama: {} },
      defaultProvider: "ollama",
    };
    expect(() => resolveProvider(config, EMPTY_ENV)).toThrow(
      'Config error: provider "ollama" requires baseURL.',
    );
  });

  test("anthropic with no apiKey is valid (SDK env fallback)", () => {
    const config: Config = {
      providers: { anthropic: { model: "claude-haiku-4-5" } },
      defaultProvider: "anthropic",
    };
    const result = resolveProvider(config, EMPTY_ENV);
    expect(result).toEqual({
      name: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: undefined,
      baseURL: undefined,
    });
  });

  test("claude-code entry with model → valid", () => {
    const config: Config = {
      providers: { "claude-code": { model: "sonnet" } },
      defaultProvider: "claude-code",
    };
    const result = resolveProvider(config, EMPTY_ENV);
    expect(result).toEqual({
      name: "claude-code",
      model: "sonnet",
      apiKey: undefined,
      baseURL: undefined,
    });
  });

  test("claude-code entry without model → valid (CLI picks its own default)", () => {
    const config: Config = {
      providers: { "claude-code": {} },
      defaultProvider: "claude-code",
    };
    const result = resolveProvider(config, EMPTY_ENV);
    expect(result).toEqual({
      name: "claude-code",
      model: undefined,
      apiKey: undefined,
      baseURL: undefined,
    });
  });
});

describe("parseModelOverride — colon forms", () => {
  const providers = {
    anthropic: { apiKey: "sk-a", model: "claude-haiku-4-5" },
    openai: { apiKey: "sk-o", model: "gpt-4o-mini" },
  };

  test("provider:model", () => {
    expect(parseModelOverride("anthropic:claude-opus-4-5", providers, "anthropic")).toEqual({
      providerName: "anthropic",
      transientModel: "claude-opus-4-5",
    });
  });

  test("provider:model splits on first colon only", () => {
    expect(parseModelOverride("openai:gpt-4o:turbo", providers, "anthropic")).toEqual({
      providerName: "openai",
      transientModel: "gpt-4o:turbo",
    });
  });

  test(":model uses defaultProvider with transient model", () => {
    expect(parseModelOverride(":claude-opus-4-5", providers, "anthropic")).toEqual({
      providerName: "anthropic",
      transientModel: "claude-opus-4-5",
    });
  });

  test("provider: (empty model) keeps stored model", () => {
    expect(parseModelOverride("openai:", providers, "anthropic")).toEqual({
      providerName: "openai",
      transientModel: undefined,
    });
  });
});

describe("parseModelOverride — empty value", () => {
  const providers = { anthropic: { apiKey: "k", model: "m" } };

  test("empty string → error", () => {
    expect(() => parseModelOverride("", providers, "anthropic")).toThrow(
      "Config error: --model value is empty.",
    );
  });

  test("whitespace-only → error", () => {
    expect(() => parseModelOverride("   ", providers, "anthropic")).toThrow(
      "Config error: --model value is empty.",
    );
  });

  test("bare colon → error", () => {
    expect(() => parseModelOverride(":", providers, "anthropic")).toThrow(
      "Config error: --model value is empty.",
    );
  });
});

describe("parseModelOverride — smart resolution (bare value)", () => {
  const providers = {
    anthropic: { apiKey: "sk-a", model: "claude-haiku-4-5" },
    openai: { apiKey: "sk-o", model: "gpt-4o-mini" },
  };

  test("matches configured provider key → that provider, stored model", () => {
    expect(parseModelOverride("openai", providers, "anthropic")).toEqual({
      providerName: "openai",
      transientModel: undefined,
    });
  });

  test("matches a single provider's configured model → that provider", () => {
    expect(parseModelOverride("gpt-4o-mini", providers, "anthropic")).toEqual({
      providerName: "openai",
      transientModel: undefined,
    });
  });

  test("matches multiple providers' models → error (use provider:model)", () => {
    const dupProviders = {
      anthropic: { apiKey: "k", model: "shared-model" },
      openai: { apiKey: "k", model: "shared-model" },
    };
    expect(() => parseModelOverride("shared-model", dupProviders, "anthropic")).toThrow(
      'Config error: model "shared-model" is configured for multiple providers; use provider:model.',
    );
  });

  test("no match, not a built-in → defaultProvider with transient model", () => {
    expect(parseModelOverride("gpt-9999", providers, "anthropic")).toEqual({
      providerName: "anthropic",
      transientModel: "gpt-9999",
    });
  });

  test("known built-in not configured → error (smart res does not fall through)", () => {
    const onlyAnthropic = { anthropic: { apiKey: "k", model: "m" } };
    expect(() => parseModelOverride("openai", onlyAnthropic, "anthropic")).toThrow(
      'Config error: provider "openai" not found in config.',
    );
  });

  test("ollama built-in not configured → error", () => {
    const onlyAnthropic = { anthropic: { apiKey: "k", model: "m" } };
    expect(() => parseModelOverride("ollama", onlyAnthropic, "anthropic")).toThrow(
      'Config error: provider "ollama" not found in config.',
    );
  });

  test("configured-key wins over built-in name check", () => {
    expect(parseModelOverride("anthropic", providers, "anthropic")).toEqual({
      providerName: "anthropic",
      transientModel: undefined,
    });
  });
});
