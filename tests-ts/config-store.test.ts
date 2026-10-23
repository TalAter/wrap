import { describe, expect, test } from "bun:test";
import { resolveSettings } from "../src/config/resolve.ts";
import { getConfig, setConfig, updateConfig } from "../src/config/store.ts";
import { seedTestConfig } from "./helpers.ts";

const emptyMods = { flags: new Set<string>(), values: new Map<string, string>() };

describe("setConfig + getConfig", () => {
  test("returns config after setConfig", () => {
    const resolved = resolveSettings(emptyMods, {}, { verbose: true, nerdFonts: false });
    setConfig(resolved);
    expect(getConfig().verbose).toBe(true);
    expect(getConfig().nerdFonts).toBe(false);
  });

  test("is idempotent — later call wins", () => {
    seedTestConfig({ verbose: false });
    seedTestConfig({ verbose: true });
    expect(getConfig().verbose).toBe(true);
  });

  test("replaces entire config (no merge)", () => {
    // 42 must not leak into the second seed — if it did, the second seed
    // merged instead of replaced. Default is 5.
    seedTestConfig({ maxRounds: 42 });
    seedTestConfig({ verbose: true });
    expect(getConfig().verbose).toBe(true);
    expect(getConfig().maxRounds).toBe(5);
  });
});

describe("updateConfig", () => {
  test("shallow-merges patch into current config", () => {
    seedTestConfig({ verbose: false, nerdFonts: false });
    updateConfig({ nerdFonts: true });
    expect(getConfig().verbose).toBe(false);
    expect(getConfig().nerdFonts).toBe(true);
  });

  test("overwrites existing keys", () => {
    seedTestConfig({ verbose: false, maxRounds: 5 });
    updateConfig({ maxRounds: 10 });
    expect(getConfig().maxRounds).toBe(10);
  });

  test("skips undefined patch values so required fields can't be cleared", () => {
    seedTestConfig({ maxRounds: 7 });
    updateConfig({ maxRounds: undefined });
    expect(getConfig().maxRounds).toBe(7);
  });
});
