import { describe, expect, test } from "bun:test";
import type { Config, ResolvedConfig } from "../src/config/config.ts";
import { applyModelOverride, resolveSettings } from "../src/config/resolve.ts";
import type { Modifiers } from "../src/core/input.ts";

function mods(opts: { flags?: string[]; values?: Record<string, string> } = {}): Modifiers {
  return {
    flags: new Set(opts.flags ?? []),
    values: new Map(Object.entries(opts.values ?? {})),
  };
}

describe("resolveSettings — precedence", () => {
  test("CLI flag wins over env and file", () => {
    const result = resolveSettings(mods({ flags: ["verbose"] }), {}, { verbose: false });
    expect(result.verbose).toBe(true);
  });

  test("env wins over file when CLI absent", () => {
    const result = resolveSettings(mods(), { WRAP_NO_ANIMATION: "1" }, { noAnimation: false });
    expect(result.noAnimation).toBe(true);
  });

  test("falsy env value overrides truthy file config", () => {
    const result = resolveSettings(mods(), { WRAP_NERD_FONTS: "0" }, { nerdFonts: true });
    expect(result.nerdFonts).toBe(false);
  });

  test("file wins over default when CLI and env absent", () => {
    const result = resolveSettings(mods(), {}, { verbose: true });
    expect(result.verbose).toBe(true);
  });

  test("default applied when CLI, env, and file absent", () => {
    const result = resolveSettings(mods(), {}, {});
    expect(result.verbose).toBe(false);
    expect(result.noAnimation).toBe(false);
    expect(result.maxRounds).toBe(5);
    expect(result.maxCapturedOutputChars).toBe(200_000);
    expect(result.maxAttachedInputChars).toBe(200_000);
    expect(result.nerdFonts).toBe(false);
    expect(result.yolo).toBe(false);
  });

  test("missing default leaves key undefined (not materialized)", () => {
    const result = resolveSettings(mods(), {}, {});
    expect(result.defaultProvider).toBeUndefined();
  });
});

describe("resolveSettings — boolean env coercion", () => {
  test("truthy env values resolve to true", () => {
    for (const val of ["1", "true", "yes", "on", "TRUE", "Yes", " on "]) {
      const result = resolveSettings(mods(), { WRAP_NO_ANIMATION: val }, {});
      expect(result.noAnimation, `env value ${JSON.stringify(val)}`).toBe(true);
    }
  });

  test("falsy env values resolve to false", () => {
    for (const val of ["0", "false", "no", "off", "", "FALSE", " 0 "]) {
      const result = resolveSettings(mods(), { WRAP_NO_ANIMATION: val }, {});
      expect(result.noAnimation, `env value ${JSON.stringify(val)}`).toBe(false);
    }
  });

  test("unrecognized env value throws with setting name and accepted values", () => {
    expect(() => resolveSettings(mods(), { WRAP_NO_ANIMATION: "maybe" }, {})).toThrow(
      /Config error: WRAP_NO_ANIMATION expected 1\/true\/yes\/on or 0\/false\/no\/off, got "maybe"/,
    );
  });

  test("WRAP_NERD_FONTS wiring — =1 enables", () => {
    const result = resolveSettings(mods(), { WRAP_NERD_FONTS: "1" }, {});
    expect(result.nerdFonts).toBe(true);
  });
});

describe("resolveSettings — number coercion", () => {
  test("file config number value passes through", () => {
    const result = resolveSettings(mods(), {}, { maxRounds: 10 });
    expect(result.maxRounds).toBe(10);
  });

  test("CLI value parses to number", () => {
    const result = resolveSettings(mods({ values: { maxRounds: "7" } }), {}, {});
    expect(result.maxRounds).toBe(7);
  });

  test("non-numeric CLI value throws with setting name in the message", () => {
    expect(() => resolveSettings(mods({ values: { maxRounds: "abc" } }), {}, {})).toThrow(
      /Config error: maxRounds expected a number, got "abc"/,
    );
  });
});

describe("resolveSettings — CLI > env precedence", () => {
  test("CLI bool flag wins over env var", () => {
    const result = resolveSettings(
      mods({ flags: ["noAnimation"] }),
      { WRAP_NO_ANIMATION: "0" },
      {},
    );
    expect(result.noAnimation).toBe(true);
  });
});

describe("resolveSettings — yolo precedence", () => {
  test("--yolo CLI flag sets yolo true", () => {
    const result = resolveSettings(mods({ flags: ["yolo"] }), {}, {});
    expect(result.yolo).toBe(true);
  });

  test("WRAP_YOLO env sets yolo true (presence = true)", () => {
    const result = resolveSettings(mods(), { WRAP_YOLO: "1" }, {});
    expect(result.yolo).toBe(true);
  });

  test("file yolo:true is picked up when CLI/env absent", () => {
    const result = resolveSettings(mods(), {}, { yolo: true });
    expect(result.yolo).toBe(true);
  });

  test("--yolo CLI flag overrides WRAP_YOLO=0 (env presence = true)", () => {
    const result = resolveSettings(mods({ flags: ["yolo"] }), { WRAP_YOLO: "0" }, {});
    expect(result.yolo).toBe(true);
  });

  test("default is false", () => {
    const result = resolveSettings(mods(), {}, {});
    expect(result.yolo).toBe(false);
  });
});

describe("resolveSettings — structural fields pass through", () => {
  test("providers map from fileConfig is preserved", () => {
    const fileConfig: Config = {
      providers: { anthropic: { apiKey: "sk-test", model: "claude-opus" } },
      defaultProvider: "anthropic",
    };
    const result = resolveSettings(mods(), {}, fileConfig);
    expect(result.providers).toEqual(fileConfig.providers);
    expect(result.defaultProvider).toBe("anthropic");
  });
});

describe("resolveSettings — noAnimation aggregates env-wide signals", () => {
  test("CI env var forces noAnimation true", () => {
    const result = resolveSettings(mods(), { CI: "true" }, {});
    expect(result.noAnimation).toBe(true);
  });

  test("CI=false does not force noAnimation (shells inherit CI=false outside CI)", () => {
    for (const val of ["false", "0", "no", "off", ""]) {
      const result = resolveSettings(mods(), { CI: val }, {});
      expect(result.noAnimation, `CI=${JSON.stringify(val)}`).toBe(false);
    }
  });

  test("TERM=dumb forces noAnimation true", () => {
    const result = resolveSettings(mods(), { TERM: "dumb" }, {});
    expect(result.noAnimation).toBe(true);
  });

  test("NO_COLOR forces noAnimation true", () => {
    const result = resolveSettings(mods(), { NO_COLOR: "1" }, {});
    expect(result.noAnimation).toBe(true);
  });

  test("NO_COLOR as empty string still forces noAnimation true (presence, not value)", () => {
    const result = resolveSettings(mods(), { NO_COLOR: "" }, {});
    expect(result.noAnimation).toBe(true);
  });

  test("TERM set to a non-dumb value does not affect noAnimation", () => {
    const result = resolveSettings(mods(), { TERM: "xterm-256color" }, {});
    expect(result.noAnimation).toBe(false);
  });

  test("env-wide signals override file config noAnimation=false", () => {
    const result = resolveSettings(mods(), { CI: "true" }, { noAnimation: false });
    expect(result.noAnimation).toBe(true);
  });
});

describe("resolveSettings — env layer skipped when value is undefined", () => {
  test("env names not present in env are skipped silently", () => {
    // No env var set at all — resolver falls through to file/default for noAnimation.
    const result = resolveSettings(mods(), {}, { noAnimation: true });
    expect(result.noAnimation).toBe(true);
  });
});

describe("resolveSettings — model is virtual", () => {
  test("model key does not appear in resolved Config", () => {
    const result = resolveSettings(
      mods({ values: { model: "anthropic:claude-opus" } }),
      { WRAP_MODEL: "openai" },
      {},
    );
    // Model resolution happens in applyModelOverride; Config has no `model` field.
    expect((result as Record<string, unknown>).model).toBeUndefined();
  });
});

describe("applyModelOverride", () => {
  const baseConfig: ResolvedConfig = {
    verbose: false,
    noAnimation: false,
    nerdFonts: false,
    yolo: false,
    maxRounds: 5,
    maxCapturedOutputChars: 200_000,
    maxAttachedInputChars: 200_000,
    providers: {
      anthropic: { apiKey: "sk-a", model: "claude-haiku-4-5" },
      openai: { apiKey: "sk-o", model: "gpt-4o-mini" },
    },
    defaultProvider: "anthropic",
  };

  test("no override → config unchanged", () => {
    const result = applyModelOverride(baseConfig, mods(), {});
    expect(result).toBe(baseConfig);
  });

  test("CLI override sets defaultProvider and writes transient model into providers map", () => {
    const result = applyModelOverride(
      baseConfig,
      mods({ values: { model: "openai:gpt-4.1" } }),
      {},
    );
    expect(result.defaultProvider).toBe("openai");
    expect(result.providers?.openai?.model).toBe("gpt-4.1");
    expect(result.providers?.openai?.apiKey).toBe("sk-o");
    // Untouched entry preserved
    expect(result.providers?.anthropic?.model).toBe("claude-haiku-4-5");
  });

  test("env (WRAP_MODEL) override works when CLI absent", () => {
    const result = applyModelOverride(baseConfig, mods(), { WRAP_MODEL: "openai" });
    expect(result.defaultProvider).toBe("openai");
    // No transient: smart match against configured provider, uses stored model
    expect(result.providers?.openai?.model).toBe("gpt-4o-mini");
  });

  test("CLI override wins over WRAP_MODEL env", () => {
    const result = applyModelOverride(baseConfig, mods({ values: { model: "anthropic" } }), {
      WRAP_MODEL: "openai",
    });
    expect(result.defaultProvider).toBe("anthropic");
  });

  test("bare model name smart-matches to a provider", () => {
    const result = applyModelOverride(baseConfig, mods({ values: { model: "gpt-4o-mini" } }), {});
    expect(result.defaultProvider).toBe("openai");
  });

  test("unknown model name falls through to defaultProvider + transient", () => {
    const result = applyModelOverride(baseConfig, mods({ values: { model: "custom-llama" } }), {});
    expect(result.defaultProvider).toBe("anthropic");
    expect(result.providers?.anthropic?.model).toBe("custom-llama");
  });

  test("invalid override propagates parse error", () => {
    expect(() => applyModelOverride(baseConfig, mods({ values: { model: "" } }), {})).toThrow(
      "Config error: --model value is empty.",
    );
  });

  test("empty-string WRAP_MODEL treated as absent, no error", () => {
    const result = applyModelOverride(baseConfig, mods(), { WRAP_MODEL: "" });
    expect(result).toBe(baseConfig);
  });

  test(":model with no defaultProvider throws actionable error", () => {
    const noDefault: Config = {
      providers: { anthropic: { apiKey: "k", model: "m" } },
    };
    expect(() => applyModelOverride(noDefault, mods({ values: { model: ":gpt-4o" } }), {})).toThrow(
      /Config error: --model ":gpt-4o" has no provider to target/,
    );
  });
});
