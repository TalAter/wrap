import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config/config.ts";
import { resolveSettings } from "../src/config/resolve.ts";
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
    expect(result.maxPipedInputChars).toBe(200_000);
    expect(result.nerdFonts).toBe(false);
  });

  test("missing default leaves key undefined (not materialized)", () => {
    const result = resolveSettings(mods(), {}, {});
    expect(result.defaultProvider).toBeUndefined();
  });
});

describe("resolveSettings — boolean coercion", () => {
  test("env var presence is truthy regardless of value", () => {
    const cases = ["1", "true", "yes", "0", "false", ""];
    for (const val of cases) {
      const result = resolveSettings(mods(), { WRAP_NO_ANIMATION: val }, {});
      expect(result.noAnimation, `env value ${JSON.stringify(val)}`).toBe(true);
    }
  });

  test("env var absent → file config wins", () => {
    const result = resolveSettings(mods(), {}, { noAnimation: true });
    expect(result.noAnimation).toBe(true);
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

  test("non-numeric CLI value throws with Config error prefix", () => {
    expect(() => resolveSettings(mods({ values: { maxRounds: "abc" } }), {}, {})).toThrow(
      /^Config error:/,
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
    // Model resolution is delegated to resolveProvider; Config has no `model` field.
    expect((result as Record<string, unknown>).model).toBeUndefined();
  });
});
