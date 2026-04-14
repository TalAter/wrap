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
// Extracted from existing hardcoded values across the codebase.

export const DARK_THEME: ThemeTokens = {
  text: {
    primary: [210, 210, 225], // #d2d2e1 — action bar, status text
    secondary: [170, 170, 195], // #aaaac3 — key hints
    muted: [115, 115, 140], // #73738c — descriptions, placeholders
    disabled: [65, 65, 80], // #414150 — separators, dividers
  },
  status: {
    success: [120, 230, 160], // low-risk badge fg
    warning: [255, 200, 80], // medium-risk badge fg, primary key hint
    error: [255, 100, 100], // high-risk badge fg
    info: [120, 180, 255], // wizard accent
  },
  chrome: {
    border: [60, 60, 100], // shared dim border color
    surface: [35, 35, 50], // #232332 — input background
    accent: [55, 45, 80], // #372d50 — selected action bg
    dim: [60, 60, 100], // gradient tail / bottom border
  },
  interactive: {
    cursor: [102, 153, 255], // #6699ff — checklist cursor
    selection: [26, 42, 77], // #1a2a4d — cursor row bg
    highlight: [245, 200, 100], // #f5c864 — primary key combo
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
// Higher contrast on bright backgrounds. Darker text, lighter chrome.

export const LIGHT_THEME: ThemeTokens = {
  text: {
    primary: [30, 30, 50], // near-black for readability
    secondary: [60, 60, 90],
    muted: [100, 100, 130],
    disabled: [170, 170, 190],
  },
  status: {
    success: [20, 140, 60],
    warning: [180, 120, 0],
    error: [200, 30, 50],
    info: [30, 100, 200],
  },
  chrome: {
    border: [180, 180, 200],
    surface: [240, 240, 245],
    accent: [220, 215, 235],
    dim: [180, 180, 200],
  },
  interactive: {
    cursor: [40, 80, 200],
    selection: [210, 220, 245],
    highlight: [160, 120, 0],
  },
  gradient: {
    wizard: [
      [30, 100, 200],
      [180, 180, 200],
    ],
    riskLow: [
      [20, 160, 140],
      [180, 180, 200],
    ],
    riskMed: [
      [180, 40, 120],
      [180, 180, 200],
    ],
    riskHigh: [
      [200, 30, 50],
      [180, 180, 200],
    ],
    dim: [180, 180, 200],
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
