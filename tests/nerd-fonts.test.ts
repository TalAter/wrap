import { afterEach, describe, expect, test } from "bun:test";
import { initNerdFonts, isNerdFonts, resetNerdFonts, resolveIcon } from "../src/core/output.ts";

afterEach(() => {
  resetNerdFonts();
});

describe("resolveIcon", () => {
  test("returns fallback when not initialized", () => {
    expect(resolveIcon("\uEC10", "x")).toBe("x");
  });

  test("returns empty string fallback by default", () => {
    expect(resolveIcon("\uEC10")).toBe("");
  });

  test("returns fallback when disabled", () => {
    initNerdFonts(false);
    expect(resolveIcon("\uEC10", "[✓]")).toBe("[✓]");
  });

  test("returns icon when enabled", () => {
    initNerdFonts(true);
    expect(resolveIcon("\uEC10", "[✓]")).toBe("\uEC10");
  });

  test("returns icon with empty fallback when enabled", () => {
    initNerdFonts(true);
    expect(resolveIcon("\uEC10")).toBe("\uEC10");
  });
});

describe("isNerdFonts", () => {
  test("false by default", () => {
    expect(isNerdFonts()).toBe(false);
  });

  test("true after initNerdFonts(true)", () => {
    initNerdFonts(true);
    expect(isNerdFonts()).toBe(true);
  });
});

describe("initNerdFonts", () => {
  test("throws on double init", () => {
    initNerdFonts(false);
    expect(() => initNerdFonts(true)).toThrow(/called more than once/);
  });
});
