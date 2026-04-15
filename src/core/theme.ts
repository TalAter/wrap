import { type Color, colorHex, quantizeColor } from "./ansi.ts";
import type { Appearance } from "./detect-appearance.ts";
import { colorLevel } from "./output.ts";

export type BadgeColors = { fg: Color; bg: Color };

export type ThemeTokens = {
  text: {
    primary: Color;
    secondary: Color;
    muted: Color;
    disabled: Color;
    accent: Color;
  };
  chrome: {
    border: Color;
    surface: Color;
    accent: Color;
    dim: Color;
  };
  interactive: {
    cursor: Color;
    selection: Color;
    highlight: Color;
  };
  select: {
    selected: Color;
  };
  badge: {
    wizard: BadgeColors;
    riskLow: BadgeColors;
    riskMedium: BadgeColors;
    riskHigh: BadgeColors;
  };
  gradient: {
    wizard: [Color, Color];
    riskLow: [Color, Color];
    riskMedium: [Color, Color];
    riskHigh: [Color, Color];
    dim: Color;
  };
};

// ── Dark theme ─────────────────────────────────────────────────────

export const DARK_THEME: ThemeTokens = {
  text: {
    primary: [210, 210, 225],
    secondary: [170, 170, 195],
    muted: [115, 115, 140],
    disabled: [65, 65, 80],
    accent: [120, 180, 255],
  },
  chrome: {
    border: [60, 60, 100],
    surface: [35, 35, 50],
    accent: [55, 45, 80],
    dim: [60, 60, 100],
  },
  interactive: {
    cursor: [102, 153, 255],
    selection: [26, 42, 77],
    highlight: [245, 200, 100],
  },
  select: {
    selected: [120, 230, 160],
  },
  badge: {
    wizard: { fg: [120, 180, 255], bg: [78, 96, 146] },
    riskLow: { fg: [120, 230, 160], bg: [78, 111, 118] },
    riskMedium: { fg: [255, 200, 80], bg: [118, 102, 94] },
    riskHigh: { fg: [255, 100, 100], bg: [118, 72, 100] },
  },
  gradient: {
    wizard: [
      [120, 180, 255],
      [60, 60, 100],
    ],
    riskLow: [
      [80, 220, 200],
      [60, 60, 100],
    ],
    riskMedium: [
      [255, 100, 200],
      [60, 60, 100],
    ],
    riskHigh: [
      [255, 60, 80],
      [60, 60, 100],
    ],
    dim: [60, 60, 100],
  },
};

// ── Light theme ────────────────────────────────────────────────────

export const LIGHT_THEME: ThemeTokens = {
  text: {
    primary: [0, 0, 0],
    secondary: [45, 45, 70],
    muted: [105, 105, 130],
    disabled: [175, 175, 195],
    accent: [25, 90, 190],
  },
  chrome: {
    border: [170, 170, 195],
    surface: [238, 238, 245],
    accent: [220, 215, 238],
    dim: [170, 170, 195],
  },
  interactive: {
    cursor: [30, 75, 195],
    selection: [210, 220, 245],
    highlight: [150, 100, 0],
  },
  select: {
    selected: [15, 125, 55],
  },
  badge: {
    wizard: { fg: [25, 90, 190], bg: [218, 230, 248] },
    riskLow: { fg: [15, 125, 55], bg: [215, 238, 220] },
    riskMedium: { fg: [160, 95, 0], bg: [248, 232, 200] },
    riskHigh: { fg: [190, 25, 45], bg: [248, 218, 218] },
  },
  gradient: {
    wizard: [
      [25, 90, 190],
      [170, 170, 195],
    ],
    riskLow: [
      [15, 150, 130],
      [170, 170, 195],
    ],
    riskMedium: [
      [175, 35, 115],
      [170, 170, 195],
    ],
    riskHigh: [
      [190, 25, 45],
      [170, 170, 195],
    ],
    dim: [170, 170, 195],
  },
};

// ── Global store ───────────────────────────────────────────────────

let activeTheme: ThemeTokens = DARK_THEME;

export function setTheme(theme: ThemeTokens): void {
  activeTheme = theme;
}

export function getTheme(): ThemeTokens {
  return activeTheme;
}

export function resolveTheme(appearance: Appearance): ThemeTokens {
  return appearance === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * Hex string for Ink, quantized to the current terminal's color level.
 * Use this for every theme color handed to an Ink <Text color> / <Box> prop —
 * Ink always emits truecolor escapes otherwise, bypassing FORCE_COLOR.
 */
export function themeHex(c: Color): string {
  return colorHex(quantizeColor(c, colorLevel()));
}
