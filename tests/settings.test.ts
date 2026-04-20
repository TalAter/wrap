import { describe, expect, test } from "bun:test";
import { SETTINGS, type Setting } from "../src/config/settings.ts";

describe("SETTINGS registry", () => {
  test("every setting declares a type and description", () => {
    for (const [key, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      expect(s.type, `${key}.type`).toBeOneOf(["boolean", "number", "string"]);
      expect(s.description.length, `${key}.description`).toBeGreaterThan(0);
    }
  });

  test("flag arrays are non-empty when present and start with --", () => {
    for (const [key, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      if (!s.flag) continue;
      expect(s.flag.length, `${key}.flag`).toBeGreaterThan(0);
      for (const f of s.flag) {
        expect(f.startsWith("--"), `${key}.flag ${f}`).toBe(true);
      }
    }
  });

  test("env arrays are non-empty when present and match WRAP_* or standard names", () => {
    for (const [key, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      if (!s.env) continue;
      expect(s.env.length, `${key}.env`).toBeGreaterThan(0);
      for (const e of s.env) {
        expect(e, `${key}.env ${e}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  test("no duplicate flag names across settings", () => {
    const seen = new Map<string, string>();
    for (const [key, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      for (const f of s.flag ?? []) {
        const prior = seen.get(f);
        expect(prior, `duplicate flag ${f} in ${key} and ${prior}`).toBeUndefined();
        seen.set(f, key);
      }
    }
  });

  test("no duplicate env var names across settings", () => {
    const seen = new Map<string, string>();
    for (const [key, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      for (const e of s.env ?? []) {
        const prior = seen.get(e);
        expect(prior, `duplicate env ${e} in ${key} and ${prior}`).toBeUndefined();
        seen.set(e, key);
      }
    }
  });

  test("default value type matches declared type when present", () => {
    for (const [key, s] of Object.entries(SETTINGS) as [string, Setting][]) {
      if (s.default === undefined) continue;
      expect(typeof s.default, `${key}.default`).toBe(s.type);
    }
  });

  test("contains expected keys covering existing Config fields", () => {
    const keys = Object.keys(SETTINGS);
    expect(keys).toContain("verbose");
    expect(keys).toContain("noAnimation");
    expect(keys).toContain("model");
    expect(keys).toContain("nerdFonts");
    expect(keys).toContain("maxRounds");
    expect(keys).toContain("maxCapturedOutputChars");
    expect(keys).toContain("maxAttachedInputChars");
    expect(keys).toContain("defaultProvider");
    expect(keys).toContain("yolo");
  });

  test("yolo declares --yolo flag and WRAP_YOLO env and defaults false", () => {
    const s = SETTINGS.yolo;
    expect(s.type).toBe("boolean");
    expect(s.flag).toContain("--yolo");
    expect(s.env).toContain("WRAP_YOLO");
    expect(s.default).toBe(false);
  });

  test("noAnimation declares both --no-animation flag and WRAP_NO_ANIMATION env", () => {
    const s = SETTINGS.noAnimation;
    expect(s.flag).toContain("--no-animation");
    expect(s.env).toContain("WRAP_NO_ANIMATION");
  });

  test("model declares --model flag with --provider alias and WRAP_MODEL env", () => {
    const s = SETTINGS.model;
    expect(s.flag).toContain("--model");
    expect(s.flag).toContain("--provider");
    expect(s.env).toContain("WRAP_MODEL");
  });

  // Runtime complement to the compile-time drift check in config.ts — catches
  // edge cases the type check can't (e.g. `default: undefined` slipping in).
  test("SETTINGS entries with defaults match the expected list", () => {
    const withDefaults = (Object.entries(SETTINGS) as [string, Setting][])
      .filter(([, s]) => s.default !== undefined)
      .map(([k]) => k)
      .sort();
    expect(withDefaults).toEqual(
      [
        "maxCapturedOutputChars",
        "maxAttachedInputChars",
        "maxRounds",
        "nerdFonts",
        "noAnimation",
        "verbose",
        "yolo",
      ].sort(),
    );
  });
});
