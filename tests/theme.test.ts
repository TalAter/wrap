import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetColorLevelCache } from "../src/core/output.ts";
import {
  DARK_THEME,
  getTheme,
  LIGHT_THEME,
  resolveTheme,
  setTheme,
  themeHex,
} from "../src/core/theme.ts";
import { isolateEnv, isolateTTY } from "./helpers.ts";

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

describe("themeHex with ColorRef overrides", () => {
  isolateEnv(["NO_COLOR", "COLORTERM", "TERM", "FORCE_COLOR"]);
  isolateTTY(true);
  beforeEach(__resetColorLevelCache);

  test("plain Color tuple resolves at truecolor unchanged", () => {
    process.env.FORCE_COLOR = "3";
    expect(themeHex([245, 186, 74])).toBe("#f5ba4a");
  });

  test("ColorRef base used at truecolor, overrides ignored", () => {
    process.env.FORCE_COLOR = "3";
    expect(themeHex({ base: [245, 186, 74], ansi16: [170, 85, 0], ansi256: [200, 100, 0] })).toBe(
      "#f5ba4a",
    );
  });

  test("ColorRef ansi16 override applied at level 1", () => {
    process.env.FORCE_COLOR = "1";
    // Base [245,186,74] would snap to ANSI 93 bright yellow [255,255,85].
    // Override [170,85,0] should snap to ANSI 33 dim yellow [170,85,0].
    expect(themeHex({ base: [245, 186, 74], ansi16: [170, 85, 0] })).toBe("#aa5500");
  });

  test("ColorRef ansi256 override applied at level 2", () => {
    process.env.FORCE_COLOR = "2";
    // Override [175, 95, 0] hits an exact 256-cube level.
    expect(themeHex({ base: [245, 186, 74], ansi256: [175, 95, 0] })).toBe("#af5f00");
  });

  test("ColorRef falls back to base when matching override missing", () => {
    process.env.FORCE_COLOR = "2";
    // No ansi256 override → base [245,186,74] quantized to 256-cube.
    const baseOnlyAt256 = themeHex({ base: [245, 186, 74], ansi16: [170, 85, 0] });
    const plainAt256 = themeHex([245, 186, 74]);
    expect(baseOnlyAt256).toBe(plainAt256);
  });
});
