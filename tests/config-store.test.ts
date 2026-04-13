import { describe, expect, test } from "bun:test";
import { getConfig, setConfig, updateConfig } from "../src/config/store.ts";

describe("setConfig + getConfig", () => {
  test("returns config after setConfig", () => {
    setConfig({ verbose: true, nerdFonts: false });
    expect(getConfig()).toEqual({ verbose: true, nerdFonts: false });
  });

  test("is idempotent — can be called multiple times", () => {
    setConfig({ verbose: false });
    setConfig({ verbose: true });
    expect(getConfig().verbose).toBe(true);
  });

  test("replaces entire config (no merge)", () => {
    setConfig({ verbose: true, nerdFonts: true });
    setConfig({ verbose: false });
    expect(getConfig()).toEqual({ verbose: false });
    expect(getConfig().nerdFonts).toBeUndefined();
  });
});

describe("updateConfig", () => {
  test("shallow-merges patch into current config", () => {
    setConfig({ verbose: false, nerdFonts: false });
    updateConfig({ nerdFonts: true });
    expect(getConfig()).toEqual({ verbose: false, nerdFonts: true });
  });

  test("overwrites existing keys", () => {
    setConfig({ verbose: false, maxRounds: 5 });
    updateConfig({ maxRounds: 10 });
    expect(getConfig().maxRounds).toBe(10);
  });
});
