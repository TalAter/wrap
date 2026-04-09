import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config/config.ts";
import { resolveProvider } from "../src/llm/resolve-provider.ts";

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("resolveProvider — test sentinel", () => {
  test("WRAP_TEST_RESPONSE set returns test sentinel regardless of config", () => {
    const result = resolveProvider({}, undefined, { WRAP_TEST_RESPONSE: "{}" });
    expect(result).toEqual({ name: "test", model: "test" });
  });

  test("WRAP_TEST_RESPONSE empty string still triggers sentinel (env present)", () => {
    const result = resolveProvider({}, undefined, { WRAP_TEST_RESPONSE: "" });
    expect(result).toEqual({ name: "test", model: "test" });
  });

  test("WRAP_TEST_RESPONSES (array variant) also triggers sentinel", () => {
    const result = resolveProvider({}, undefined, { WRAP_TEST_RESPONSES: "[]" });
    expect(result).toEqual({ name: "test", model: "test" });
  });

  test("sentinel ignores override and config", () => {
    const config: Config = {
      providers: { anthropic: { apiKey: "k", model: "claude" } },
      defaultProvider: "anthropic",
    };
    const result = resolveProvider(config, "openai:gpt-4o", { WRAP_TEST_RESPONSE: "x" });
    expect(result).toEqual({ name: "test", model: "test" });
  });
});

describe("resolveProvider — defaultProvider path (no override)", () => {
  test("returns resolved entry from defaultProvider", () => {
    const config: Config = {
      providers: {
        anthropic: { apiKey: "sk-x", model: "claude-haiku-4-5" },
      },
      defaultProvider: "anthropic",
    };
    expect(resolveProvider(config, undefined, EMPTY_ENV)).toEqual({
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
    const result = resolveProvider(config, undefined, EMPTY_ENV);
    expect(result.baseURL).toBe("http://localhost:11434/v1");
    expect(result.model).toBe("llama3.2");
  });

  test("missing providers map → generic config error", () => {
    expect(() => resolveProvider({}, undefined, EMPTY_ENV)).toThrow(
      "Config error: no LLM configured. Edit ~/.wrap/config.jsonc.",
    );
  });

  test("empty providers map → generic config error", () => {
    expect(() =>
      resolveProvider({ providers: {}, defaultProvider: "anthropic" }, undefined, EMPTY_ENV),
    ).toThrow("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.");
  });

  test("defaultProvider unset → generic config error", () => {
    expect(() =>
      resolveProvider(
        { providers: { anthropic: { apiKey: "k", model: "m" } } },
        undefined,
        EMPTY_ENV,
      ),
    ).toThrow("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.");
  });

  test("defaultProvider not in providers → generic config error", () => {
    expect(() =>
      resolveProvider(
        {
          providers: { anthropic: { apiKey: "k", model: "m" } },
          defaultProvider: "openai",
        },
        undefined,
        EMPTY_ENV,
      ),
    ).toThrow("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.");
  });

  test("resolved entry has no model → generic config error", () => {
    expect(() =>
      resolveProvider(
        {
          providers: { anthropic: { apiKey: "k" } },
          defaultProvider: "anthropic",
        },
        undefined,
        EMPTY_ENV,
      ),
    ).toThrow("Config error: no LLM configured. Edit ~/.wrap/config.jsonc.");
  });
});

describe("resolveProvider — override colon form", () => {
  const config: Config = {
    providers: {
      anthropic: { apiKey: "sk-a", model: "claude-haiku-4-5" },
      openai: { apiKey: "sk-o", model: "gpt-4o-mini" },
    },
    defaultProvider: "anthropic",
  };

  test("provider:model uses provider entry with transient model", () => {
    const result = resolveProvider(config, "anthropic:claude-opus-4-5", EMPTY_ENV);
    expect(result).toEqual({
      name: "anthropic",
      model: "claude-opus-4-5",
      apiKey: "sk-a",
      baseURL: undefined,
    });
  });

  test("provider:model splits on first colon only", () => {
    const result = resolveProvider(config, "openai:gpt-4o:turbo", EMPTY_ENV);
    expect(result.name).toBe("openai");
    expect(result.model).toBe("gpt-4o:turbo");
  });

  test(":model uses defaultProvider with transient model", () => {
    const result = resolveProvider(config, ":claude-opus-4-5", EMPTY_ENV);
    expect(result.name).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-5");
  });

  test("provider: (empty model) uses provider's stored model", () => {
    const result = resolveProvider(config, "openai:", EMPTY_ENV);
    expect(result.name).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
  });

  test("provider:model where provider not in config → error", () => {
    expect(() => resolveProvider(config, "groq:llama", EMPTY_ENV)).toThrow(
      'Config error: provider "groq" not found in config.',
    );
  });

  test("known built-in not in config → error", () => {
    const onlyAnthropic: Config = {
      providers: { anthropic: { apiKey: "k", model: "m" } },
      defaultProvider: "anthropic",
    };
    expect(() => resolveProvider(onlyAnthropic, "openai:gpt-4o", EMPTY_ENV)).toThrow(
      'Config error: provider "openai" not found in config.',
    );
  });
});

describe("resolveProvider — override empty value", () => {
  const config: Config = {
    providers: { anthropic: { apiKey: "k", model: "m" } },
    defaultProvider: "anthropic",
  };

  test("empty string → error", () => {
    expect(() => resolveProvider(config, "", EMPTY_ENV)).toThrow(
      "Config error: --model value is empty.",
    );
  });

  test("whitespace-only → error", () => {
    expect(() => resolveProvider(config, "   ", EMPTY_ENV)).toThrow(
      "Config error: --model value is empty.",
    );
  });

  test("bare colon → error", () => {
    expect(() => resolveProvider(config, ":", EMPTY_ENV)).toThrow(
      "Config error: --model value is empty.",
    );
  });
});

describe("resolveProvider — override smart resolution (bare value)", () => {
  const config: Config = {
    providers: {
      anthropic: { apiKey: "sk-a", model: "claude-haiku-4-5" },
      openai: { apiKey: "sk-o", model: "gpt-4o-mini" },
    },
    defaultProvider: "anthropic",
  };

  test("matches provider key → use that entry's stored model", () => {
    const result = resolveProvider(config, "openai", EMPTY_ENV);
    expect(result).toEqual({
      name: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-o",
      baseURL: undefined,
    });
  });

  test("matches single provider model → use that entry", () => {
    const result = resolveProvider(config, "gpt-4o-mini", EMPTY_ENV);
    expect(result.name).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
  });

  test("matches multiple providers' models → error", () => {
    const dupConfig: Config = {
      providers: {
        anthropic: { apiKey: "k", model: "shared-model" },
        openai: { apiKey: "k", model: "shared-model" },
      },
      defaultProvider: "anthropic",
    };
    expect(() => resolveProvider(dupConfig, "shared-model", EMPTY_ENV)).toThrow(
      'Config error: model "shared-model" is configured for multiple providers; use provider:model.',
    );
  });

  test("no match, not a built-in → defaultProvider with transient", () => {
    const result = resolveProvider(config, "gpt-9999", EMPTY_ENV);
    expect(result.name).toBe("anthropic");
    expect(result.model).toBe("gpt-9999");
    expect(result.apiKey).toBe("sk-a");
  });

  test("known built-in not configured → error (smart res does not fall through)", () => {
    const onlyAnthropic: Config = {
      providers: { anthropic: { apiKey: "k", model: "m" } },
      defaultProvider: "anthropic",
    };
    expect(() => resolveProvider(onlyAnthropic, "openai", EMPTY_ENV)).toThrow(
      'Config error: provider "openai" not found in config.',
    );
  });

  test("ollama built-in not configured → error", () => {
    const onlyAnthropic: Config = {
      providers: { anthropic: { apiKey: "k", model: "m" } },
      defaultProvider: "anthropic",
    };
    expect(() => resolveProvider(onlyAnthropic, "ollama", EMPTY_ENV)).toThrow(
      'Config error: provider "ollama" not found in config.',
    );
  });

  test("smart res: configured-key wins over built-in name check", () => {
    const result = resolveProvider(config, "anthropic", EMPTY_ENV);
    expect(result.name).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-4-5");
  });
});

describe("resolveProvider — override flag with entry having no model", () => {
  test("provider override → specific override-flag error", () => {
    const config: Config = {
      providers: { anthropic: { apiKey: "k" } },
      defaultProvider: "anthropic",
    };
    expect(() => resolveProvider(config, "anthropic", EMPTY_ENV)).toThrow(
      'Config error: provider "anthropic" has no model set in config.',
    );
  });
});

describe("resolveProvider — per-entry validation", () => {
  test("ollama without baseURL → ollama error", () => {
    const config: Config = {
      providers: { ollama: { model: "llama3.2" } },
      defaultProvider: "ollama",
    };
    expect(() => resolveProvider(config, undefined, EMPTY_ENV)).toThrow(
      'Config error: provider "ollama" requires baseURL.',
    );
  });

  test("ollama with baseURL → valid", () => {
    const config: Config = {
      providers: { ollama: { baseURL: "http://localhost:11434/v1", model: "llama3.2" } },
      defaultProvider: "ollama",
    };
    const result = resolveProvider(config, undefined, EMPTY_ENV);
    expect(result.name).toBe("ollama");
  });

  test("unknown provider with all required fields → valid", () => {
    const config: Config = {
      providers: {
        groq: {
          baseURL: "https://api.groq.com/openai/v1",
          apiKey: "gsk_x",
          model: "llama-3.1-70b-versatile",
        },
      },
      defaultProvider: "groq",
    };
    const result = resolveProvider(config, undefined, EMPTY_ENV);
    expect(result).toEqual({
      name: "groq",
      model: "llama-3.1-70b-versatile",
      apiKey: "gsk_x",
      baseURL: "https://api.groq.com/openai/v1",
    });
  });

  test("unknown provider missing apiKey → error", () => {
    const config: Config = {
      providers: {
        groq: { baseURL: "https://api.groq.com/openai/v1", model: "llama" },
      },
      defaultProvider: "groq",
    };
    expect(() => resolveProvider(config, undefined, EMPTY_ENV)).toThrow(
      'Config error: provider "groq" requires baseURL, apiKey, and model.',
    );
  });

  test("unknown provider missing baseURL → error", () => {
    const config: Config = {
      providers: { groq: { apiKey: "gsk_x", model: "llama" } },
      defaultProvider: "groq",
    };
    expect(() => resolveProvider(config, undefined, EMPTY_ENV)).toThrow(
      'Config error: provider "groq" requires baseURL, apiKey, and model.',
    );
  });

  test("unknown provider missing both apiKey and model → entry validator wins", () => {
    const config: Config = {
      providers: { groq: { baseURL: "https://api.groq.com/openai/v1" } },
      defaultProvider: "groq",
    };
    // Without ordering: would report generic "no LLM configured" via the model
    // check. Per-entry validation must fire first so users see the actionable
    // requires-three-fields message.
    expect(() => resolveProvider(config, undefined, EMPTY_ENV)).toThrow(
      'Config error: provider "groq" requires baseURL, apiKey, and model.',
    );
  });

  test("ollama missing both baseURL and model → baseURL error wins", () => {
    const config: Config = {
      providers: { ollama: {} },
      defaultProvider: "ollama",
    };
    expect(() => resolveProvider(config, undefined, EMPTY_ENV)).toThrow(
      'Config error: provider "ollama" requires baseURL.',
    );
  });

  test("anthropic with no apiKey is valid (SDK env fallback)", () => {
    const config: Config = {
      providers: { anthropic: { model: "claude-haiku-4-5" } },
      defaultProvider: "anthropic",
    };
    const result = resolveProvider(config, undefined, EMPTY_ENV);
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
    const result = resolveProvider(config, undefined, EMPTY_ENV);
    expect(result).toEqual({
      name: "claude-code",
      model: "sonnet",
      apiKey: undefined,
      baseURL: undefined,
    });
  });
});
