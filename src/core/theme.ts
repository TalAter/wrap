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
    /** Brighter variant of `highlight` used for the focused primary item
     *  in an ActionBar, so the selection reads as an active pill. */
    highlightBright: Color;
  };
  select: {
    selected: Color;
  };
  badge: {
    wizard: BadgeColors;
    riskLow: BadgeColors;
    riskMedium: BadgeColors;
    riskHigh: BadgeColors;
    fold: BadgeColors;
    stepDone: BadgeColors;
    stepActive: BadgeColors;
    stepPending: BadgeColors;
  };
  gradient: {
    wizard: [Color, Color];
    welcomeLogo: [Color, Color];
    welcomeBrain: [Color, Color];
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
    highlight: [245, 186, 74],
    highlightBright: [245, 186, 74],
  },
  select: {
    selected: [120, 230, 160],
  },
  badge: {
    wizard: { fg: [210, 210, 225], bg: [30, 50, 90] },
    riskLow: { fg: [102, 204, 136], bg: [25, 70, 60] },
    riskMedium: { fg: [255, 200, 80], bg: [80, 50, 20] },
    riskHigh: { fg: [255, 100, 100], bg: [80, 25, 25] },
    fold: { fg: [210, 210, 225], bg: [60, 60, 100] },
    stepDone: { fg: [130, 220, 160], bg: [40, 90, 60] },
    stepActive: { fg: [180, 200, 255], bg: [60, 80, 160] },
    stepPending: { fg: [100, 100, 140], bg: [50, 50, 80] },
  },
  gradient: {
    wizard: [
      [120, 180, 255],
      [60, 60, 100],
    ],
    welcomeLogo: [
      [179, 179, 179],
      [255, 255, 255],
    ],
    welcomeBrain: [
      [211, 76, 243],
      [29, 227, 235],
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
    surface: [218, 232, 250],
    accent: [220, 215, 238],
    dim: [170, 170, 195],
  },
  interactive: {
    cursor: [30, 75, 195],
    selection: [210, 220, 245],
    highlight: [255, 165, 50],
    highlightBright: [255, 165, 50],
  },
  select: {
    selected: [15, 125, 55],
  },
  badge: {
    wizard: { fg: [10, 20, 90], bg: [150, 175, 220] },
    riskLow: { fg: [15, 125, 55], bg: [215, 238, 220] },
    riskMedium: { fg: [160, 95, 0], bg: [248, 232, 200] },
    riskHigh: { fg: [190, 25, 45], bg: [248, 218, 218] },
    fold: { fg: [45, 45, 70], bg: [210, 215, 230] },
    stepDone: { fg: [15, 110, 55], bg: [210, 240, 215] },
    stepActive: { fg: [30, 75, 190], bg: [210, 225, 250] },
    stepPending: { fg: [130, 130, 155], bg: [220, 220, 230] },
  },
  gradient: {
    wizard: [
      [25, 90, 190],
      [170, 170, 195],
    ],
    welcomeLogo: [
      [160, 121, 191],
      [79, 94, 133],
    ],
    welcomeBrain: [
      [211, 76, 243],
      [29, 227, 235],
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
