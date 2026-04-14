import { afterEach, describe, expect, test } from "bun:test";
import type { Color } from "../src/core/ansi.ts";
import {
  DARK_THEME,
  getTheme,
  LIGHT_THEME,
  resolveTheme,
  setTheme,
  type ThemeTokens,
} from "../src/core/theme.ts";

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

function assertValidColor(c: Color, _label: string) {
  expect(c).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    const v = c[i] as number;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(255);
    expect(Number.isInteger(v)).toBe(true);
  }
}

function assertValidTheme(theme: ThemeTokens, name: string) {
  // Text tokens
  for (const [key, color] of Object.entries(theme.text)) {
    assertValidColor(color, `${name}.text.${key}`);
  }
  // Status tokens
  for (const [key, color] of Object.entries(theme.status)) {
    assertValidColor(color, `${name}.status.${key}`);
  }
  // Chrome tokens
  for (const [key, color] of Object.entries(theme.chrome)) {
    assertValidColor(color, `${name}.chrome.${key}`);
  }
  // Interactive tokens
  for (const [key, color] of Object.entries(theme.interactive)) {
    assertValidColor(color, `${name}.interactive.${key}`);
  }
  // Gradient endpoints
  for (const [key, stops] of Object.entries(theme.gradient)) {
    if (Array.isArray(stops[0])) {
      // [Color, Color] pair
      assertValidColor(stops[0] as Color, `${name}.gradient.${key}[0]`);
      assertValidColor(stops[1] as Color, `${name}.gradient.${key}[1]`);
    } else {
      // Single Color (dim)
      assertValidColor(stops as unknown as Color, `${name}.gradient.${key}`);
    }
  }
}

describe("DARK_THEME", () => {
  test("all tokens are valid RGB", () => {
    assertValidTheme(DARK_THEME, "dark");
  });
});

describe("LIGHT_THEME", () => {
  test("all tokens are valid RGB", () => {
    assertValidTheme(LIGHT_THEME, "light");
  });
});
