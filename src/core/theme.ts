import {
  ANSI16,
  type ColorRef,
  type FrameStops,
  resolveColor,
  resolveColorHex,
  type TokenPair,
} from "wrap-core/ansi";
import {
  type Appearance,
  type CoreThemeTokens,
  DARK_CORE,
  getTheme,
  LIGHT_CORE,
  setTheme,
} from "wrap-core/theme";

// ── Re-exports ────────────────────────────────────────────────────

export type { Appearance, ColorRef, FrameStops, TokenPair, TokenPair as BadgeColors };
export { getTheme, resolveColor, resolveColorHex, setTheme };

/** Map appearance to wrap's extended theme (DARK_THEME or LIGHT_THEME). */
export function resolveTheme(appearance: Appearance): WrapTheme {
  return appearance === "light" ? LIGHT_THEME : DARK_THEME;
}

// ── WrapTheme ─────────────────────────────────────────────────────

export type WrapTheme = CoreThemeTokens & {
  dialog: CoreThemeTokens["dialog"] & {
    outputLabel: ColorRef;
    outputText: ColorRef;
    explanation: ColorRef;
    plan: ColorRef;
    foldIndicator: TokenPair;
    composePill: TokenPair;
  };
  wizard: {
    frame: FrameStops;
    labelPill: TokenPair;
    stepDone: TokenPair;
    stepActive: TokenPair;
    stepPending: TokenPair;
    providerLink: ColorRef;
    nerdChoiceMarker: ColorRef;
    nerdChoiceLabel: ColorRef;
    nerdChoiceSelectedLabel: ColorRef;
    welcomeLogo: FrameStops;
    welcomeBrain: readonly [number, number, number][];
  };
  risk: {
    low: { frame: FrameStops; pill: TokenPair };
    medium: { frame: FrameStops; pill: TokenPair };
    high: { frame: FrameStops; pill: TokenPair };
  };
  forget: {
    frame: FrameStops;
  };
};

/** Backward-compat alias so `import { ThemeTokens }` still works in wrap. */
export type ThemeTokens = WrapTheme;

// ── Dark theme ─────────────────────────────────────────────────────

export const DARK_THEME: WrapTheme = {
  ...DARK_CORE,
  dialog: {
    ...DARK_CORE.dialog,
    outputLabel: { base: [115, 115, 140], ansi16: ANSI16.white },
    outputText: [170, 170, 195],
    explanation: { base: [115, 115, 140], ansi16: ANSI16.white },
    plan: [120, 180, 255],
    foldIndicator: { fg: [210, 210, 225], bg: [60, 60, 100] },
    composePill: { fg: [102, 204, 136], bg: [25, 70, 60] },
  },
  wizard: {
    frame: [
      [120, 180, 255],
      [60, 60, 100],
    ],
    labelPill: { fg: [210, 210, 225], bg: [30, 50, 90] },
    stepDone: { fg: [130, 220, 160], bg: [40, 90, 60] },
    stepActive: { fg: [180, 200, 255], bg: [60, 80, 160] },
    stepPending: { fg: [100, 100, 140], bg: [50, 50, 80] },
    providerLink: { base: [115, 115, 140], ansi16: ANSI16.white },
    nerdChoiceMarker: { base: [245, 186, 74], ansi16: ANSI16.brightYellow },
    nerdChoiceLabel: { base: [115, 115, 140], ansi16: ANSI16.white },
    nerdChoiceSelectedLabel: [210, 210, 225],
    welcomeLogo: [
      [179, 179, 179],
      [255, 255, 255],
    ],
    welcomeBrain: [
      [245, 186, 74],
      [206, 114, 255],
      [94, 214, 255],
    ],
  },
  risk: {
    low: {
      frame: [
        [80, 220, 200],
        [60, 60, 100],
      ],
      pill: { fg: [102, 204, 136], bg: [25, 70, 60] },
    },
    medium: {
      frame: [
        [255, 100, 200],
        [60, 60, 100],
      ],
      pill: { fg: [255, 200, 80], bg: [80, 50, 20] },
    },
    high: {
      frame: [
        [255, 60, 80],
        [60, 60, 100],
      ],
      pill: { fg: [255, 100, 100], bg: [80, 25, 25] },
    },
  },
  forget: {
    frame: [
      [255, 60, 80],
      [60, 60, 100],
    ],
  },
};

// ── Light theme ────────────────────────────────────────────────────

export const LIGHT_THEME: WrapTheme = {
  ...LIGHT_CORE,
  dialog: {
    ...LIGHT_CORE.dialog,
    outputLabel: [105, 105, 130],
    outputText: [45, 45, 70],
    explanation: [105, 105, 130],
    plan: [25, 90, 190],
    foldIndicator: { fg: [45, 45, 70], bg: [210, 215, 230] },
    composePill: { fg: [15, 125, 55], bg: [215, 238, 220] },
  },
  wizard: {
    frame: [
      [25, 90, 190],
      [170, 170, 195],
    ],
    labelPill: { fg: [10, 20, 90], bg: [150, 175, 220] },
    stepDone: { fg: [15, 110, 55], bg: [210, 240, 215] },
    stepActive: { fg: [30, 75, 190], bg: [210, 225, 250] },
    stepPending: { fg: [130, 130, 155], bg: [220, 220, 230] },
    providerLink: [105, 105, 130],
    nerdChoiceMarker: [255, 165, 50],
    nerdChoiceLabel: [105, 105, 130],
    nerdChoiceSelectedLabel: [0, 0, 0],
    welcomeLogo: [
      [160, 121, 191],
      [79, 94, 133],
    ],
    welcomeBrain: [
      [211, 76, 243],
      [29, 227, 235],
    ],
  },
  risk: {
    low: {
      frame: [
        [15, 150, 130],
        [170, 170, 195],
      ],
      pill: { fg: [15, 125, 55], bg: [215, 238, 220] },
    },
    medium: {
      frame: [
        [175, 35, 115],
        [170, 170, 195],
      ],
      pill: { fg: [160, 95, 0], bg: [248, 232, 200] },
    },
    high: {
      frame: [
        [190, 25, 45],
        [170, 170, 195],
      ],
      pill: { fg: [190, 25, 45], bg: [248, 218, 218] },
    },
  },
  forget: {
    frame: [
      [190, 25, 45],
      [170, 170, 195],
    ],
  },
};
