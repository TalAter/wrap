import { type Color, colorHex, quantizeColor } from "./ansi.ts";
import type { Appearance } from "./detect-appearance.ts";
import { colorLevel } from "./output.ts";

export type ThemeTokens = {
  text: {
    primary: Color;
    secondary: Color;
    muted: Color;
    disabled: Color;
  };
  status: {
    success: Color;
    warning: Color;
    error: Color;
    info: Color;
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
  gradient: {
    wizard: [Color, Color];
    riskLow: [Color, Color];
    riskMed: [Color, Color];
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
  },
  status: {
    success: [120, 230, 160],
    warning: [255, 200, 80],
    error: [255, 100, 100],
    info: [120, 180, 255],
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
  gradient: {
    wizard: [
      [120, 180, 255],
      [60, 60, 100],
    ],
    riskLow: [
      [80, 220, 200],
      [60, 60, 100],
    ],
    riskMed: [
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
    primary: [25, 25, 40], // near-black for readability
    secondary: [70, 70, 95],
    muted: [105, 105, 130],
    disabled: [175, 175, 195],
  },
  status: {
    success: [15, 125, 55],
    warning: [160, 95, 0],
    error: [190, 25, 45],
    info: [25, 90, 190],
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
  gradient: {
    wizard: [
      [25, 90, 190],
      [170, 170, 195],
    ],
    riskLow: [
      [15, 150, 130],
      [170, 170, 195],
    ],
    riskMed: [
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

/**
 * Blend a foreground toward the theme's dim endpoint to produce a badge
 * background that reads as "same hue, muted" rather than a heavy rectangle.
 *
 * Dark mode (fg brighter than dim): 30/70 pulls dark-tinted bg up to elevate.
 * Light mode (fg darker than dim): 18/82 keeps bg pale-tinted so dark text
 * on a near-white surface doesn't collapse into muddy gray.
 */
export function blendBadgeBg(fg: Color, dim: Color): Color {
  const fgSum = fg[0] + fg[1] + fg[2];
  const dimSum = dim[0] + dim[1] + dim[2];
  const r = fgSum < dimSum ? 0.18 : 0.3;
  const inv = 1 - r;
  return [
    Math.round(fg[0] * r + dim[0] * inv),
    Math.round(fg[1] * r + dim[1] * inv),
    Math.round(fg[2] * r + dim[2] * inv),
  ];
}
