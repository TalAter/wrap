import { describe, expect, test } from "bun:test";
import { SETTINGS, type Setting } from "../src/config/settings.ts";
import { options } from "../src/subcommands/registry.ts";

describe("options derived from SETTINGS", () => {
  test("every SETTINGS entry with a flag produces an Option", () => {
    const derivedFlags = new Set(options.map((o) => o.flag));
    for (const [, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      if (!s.flag || s.flag.length === 0) continue;
      expect(derivedFlags.has(s.flag[0] as string)).toBe(true);
    }
  });

  test("Option ids match SETTINGS keys", () => {
    const ids = new Set(options.map((o) => o.id));
    expect(ids.has("verbose")).toBe(true);
    expect(ids.has("noAnimation")).toBe(true);
    expect(ids.has("model")).toBe(true);
  });

  test("takesValue reflects setting type", () => {
    const byId = new Map(options.map((o) => [o.id, o]));
    expect(byId.get("verbose")?.takesValue).toBe(false);
    expect(byId.get("noAnimation")?.takesValue).toBe(false);
    expect(byId.get("model")?.takesValue).toBe(true);
  });

  test("aliases pulled from setting.flag[1..]", () => {
    const byId = new Map(options.map((o) => [o.id, o]));
    const model = byId.get("model");
    expect(model?.aliases).toContain("--provider");
  });

  test("flagless settings are excluded from options", () => {
    const ids = new Set(options.map((o) => o.id));
    expect(ids.has("maxRounds")).toBe(false);
    expect(ids.has("nerdFonts")).toBe(false);
    expect(ids.has("defaultProvider")).toBe(false);
  });
});
