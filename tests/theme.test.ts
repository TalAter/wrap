import { afterEach, describe, expect, test } from "bun:test";
import { DARK_THEME, getTheme, LIGHT_THEME, resolveTheme, setTheme } from "../src/core/theme.ts";

afterEach(() => {
  // Reset to dark so other test files aren't affected
  setTheme(DARK_THEME);
});

describe("resolveTheme", () => {
  test("returns DARK_THEME for 'dark'", () => {
    expect(resolveTheme("dark")).toBe(DARK_THEME);
  });

  test("returns LIGHT_THEME for 'light'", () => {
    expect(resolveTheme("light")).toBe(LIGHT_THEME);
  });
});

describe("theme store", () => {
  test("setTheme + getTheme round-trips", () => {
    setTheme(LIGHT_THEME);
    expect(getTheme()).toBe(LIGHT_THEME);
    setTheme(DARK_THEME);
    expect(getTheme()).toBe(DARK_THEME);
  });
});
