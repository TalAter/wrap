import { beforeEach, describe, expect, test } from "bun:test";
import { setConfig } from "../src/config/store.ts";
import { isNerdFonts, resolveIcon } from "../src/core/output.ts";

beforeEach(() => {
  setConfig({ nerdFonts: false });
});

describe("resolveIcon", () => {
  test("returns fallback when disabled", () => {
    expect(resolveIcon("\uEC10", "[✓]")).toBe("[✓]");
  });

  test("returns empty string fallback by default", () => {
    expect(resolveIcon("\uEC10")).toBe("");
  });

  test("returns icon when enabled", () => {
    setConfig({ nerdFonts: true });
    expect(resolveIcon("\uEC10", "[✓]")).toBe("\uEC10");
  });

  test("returns icon with empty fallback when enabled", () => {
    setConfig({ nerdFonts: true });
    expect(resolveIcon("\uEC10")).toBe("\uEC10");
  });
});

describe("isNerdFonts", () => {
  test("false when disabled", () => {
    expect(isNerdFonts()).toBe(false);
  });

  test("true when enabled", () => {
    setConfig({ nerdFonts: true });
    expect(isNerdFonts()).toBe(true);
  });
});
