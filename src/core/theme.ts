import { ANSI16, type Color, colorHex, quantizeColor } from "./ansi.ts";
import type { Appearance } from "./detect-appearance.ts";
import { colorLevel } from "./output.ts";

/** Theme color: truecolor RGB, optionally with overrides for when the
 *  auto-snap to ansi16/256 lands on a harsh palette slot. */
export type ColorRef = Color | { base: Color; ansi16?: Color; ansi256?: Color };

export type TokenPair = { fg: ColorRef; bg: ColorRef };
export type BadgeColors = TokenPair;

type FrameStops = [Color, Color];

export type ThemeTokens = {
  /** Main prose and general copy surfaces outside specialized controls. */
  copy: {
    /** Default readable text, e.g. wizard body copy. */
    body: ColorRef;
    /** Secondary prose, e.g. less-prominent supporting lines. */
    supporting: ColorRef;
    /** De-emphasized prose, e.g. small notes and helper text. */
    note: ColorRef;
    /** Unavailable or inactive copy. */
    unavailable: ColorRef;
    /** Inline URL or link-like copy, e.g. API key URL. */
    link: ColorRef;
    /** Featured inline word or phrase, e.g. "taste" on welcome. */
    pop: ColorRef;
    /** Positive inline copy, e.g. "~45 seconds" on welcome. */
    success: ColorRef;
  };
  /** Response dialog content and chrome text. */
  dialog: {
    /** Bottom-border status text, e.g. "Running step...". */
    status: ColorRef;
    /** Dialog prompt copy, e.g. "Run command?". */
    prompt: ColorRef;
    /** Captured output label, e.g. "Output:". */
    outputLabel: ColorRef;
    /** Captured output body text. */
    outputText: ColorRef;
    /** Command explanation shown under the command. */
    explanation: ColorRef;
    /** Multi-step plan text, e.g. "Plan: ...". */
    plan: ColorRef;
    /** Folded-command pill, e.g. "12 lines hidden". */
    foldIndicator: TokenPair;
    /** Top pill for interactive compose mode. */
    composePill: TokenPair;
  };
  /** Text input and command display frame. */
  input: {
    /** InputFrame background. */
    surface: ColorRef;
    /** Typed, read-only, or command text inside the input frame. */
    text: ColorRef;
    /** Placeholder text inside editable inputs. */
    placeholder: ColorRef;
    /** Temporary editor handoff message inside the input frame. */
    editorStatus: ColorRef;
  };
  /** Bottom-row key/action hints across dialogs and wizard screens. */
  actionBar: {
    /** Action label text, e.g. "to cancel" or "Follow-up". */
    label: ColorRef;
    /** Label text for currently focused action-bar item. */
    selected: ColorRef;
    /** Regular hotkey/glyph, e.g. Esc, Space, E/F/C letters. */
    shortcut: ColorRef;
    /** Primary hotkey/glyph, e.g. Enter or No/Yes before separator. */
    shortcutPrimary: ColorRef;
    /** Regular hotkey/glyph when its action is focused. */
    selectedShortcut: ColorRef;
    /** Primary hotkey/glyph when its action is focused. */
    selectedShortcutPrimary: ColorRef;
    /** Background for currently focused action-bar item. */
    selectedBg: ColorRef;
    /** Separator between action groups, e.g. "│". */
    separator: ColorRef;
    /** Temporary success state, e.g. Copy -> Copied. */
    success: ColorRef;
  };
  /** Multi-select checklist rows and section headers. */
  checklist: {
    /** Unchecked, unfocused option row. */
    row: ColorRef;
    /** Checked option row. */
    rowChecked: ColorRef;
    /** Focused option row text. */
    rowFocused: ColorRef;
    /** Focused option row background. */
    rowFocusedBg: ColorRef;
    /** Section header label, e.g. "SELECT API PROVIDER(S)". */
    sectionLabel: ColorRef;
    /** Section header rule/dot leader. */
    sectionRule: ColorRef;
  };
  /** @inkjs/ui Select picker colors for model/default-provider screens. */
  picker: {
    /** Unfocused, unselected option. */
    option: ColorRef;
    /** Focused option. */
    optionFocused: ColorRef;
    /** Selected option. */
    optionSelected: ColorRef;
    /** Focus indicator marker. */
    focusIndicator: ColorRef;
    /** Selected indicator marker. */
    selectedIndicator: ColorRef;
  };
  /** Setup wizard frame, breadcrumbs, and welcome-specific visuals. */
  wizard: {
    /** Wizard dialog border gradient. */
    frame: FrameStops;
    /** "Setup Wizard" top-border pill. */
    labelPill: TokenPair;
    /** Completed breadcrumb step pill. */
    stepDone: TokenPair;
    /** Current breadcrumb step pill. */
    stepActive: TokenPair;
    /** Future breadcrumb step pill. */
    stepPending: TokenPair;
    /** Provider API key URL. */
    providerLink: ColorRef;
    /** Marker for selected nerd-font choice. */
    nerdChoiceMarker: ColorRef;
    /** Unselected nerd-font choice label. */
    nerdChoiceLabel: ColorRef;
    /** Selected nerd-font choice label. */
    nerdChoiceSelectedLabel: ColorRef;
    /** Welcome logo gradient. */
    welcomeLogo: FrameStops;
    /** Welcome animation brain colors. */
    welcomeBrain: readonly Color[];
  };
  /** Risk confirmation frame and badge colors. */
  risk: {
    /** Low-risk dialog border and risk pill. */
    low: { frame: FrameStops; pill: TokenPair };
    /** Medium-risk dialog border and risk pill. */
    medium: { frame: FrameStops; pill: TokenPair };
    /** High-risk dialog border and risk pill. */
    high: { frame: FrameStops; pill: TokenPair };
  };
  /** Forget dialog colors. */
  forget: {
    /** Forget dialog border gradient. */
    frame: FrameStops;
  };
};

// ── Dark theme ─────────────────────────────────────────────────────

export const DARK_THEME: ThemeTokens = {
  copy: {
    body: [210, 210, 225],
    supporting: [170, 170, 195],
    note: { base: [115, 115, 140], ansi16: ANSI16.white },
    unavailable: [65, 65, 80],
    link: [120, 180, 255],
    pop: { base: [245, 186, 74], ansi16: ANSI16.brightYellow },
    success: { base: [120, 230, 160], ansi16: ANSI16.green },
  },
  dialog: {
    status: [210, 210, 225],
    prompt: [210, 210, 225],
    outputLabel: { base: [115, 115, 140], ansi16: ANSI16.white },
    outputText: [170, 170, 195],
    explanation: { base: [115, 115, 140], ansi16: ANSI16.white },
    plan: [120, 180, 255],
    foldIndicator: { fg: [210, 210, 225], bg: [60, 60, 100] },
    composePill: { fg: [102, 204, 136], bg: [25, 70, 60] },
  },
  input: {
    surface: [35, 35, 50],
    text: [210, 210, 225],
    placeholder: { base: [115, 115, 140], ansi16: ANSI16.white },
    editorStatus: { base: [115, 115, 140], ansi16: ANSI16.white },
  },
  actionBar: {
    label: { base: [115, 115, 140], ansi16: ANSI16.white },
    selected: [210, 210, 225],
    shortcut: [170, 170, 195],
    shortcutPrimary: { base: [245, 186, 74], ansi16: ANSI16.brightYellow },
    selectedShortcut: [210, 210, 225],
    selectedShortcutPrimary: { base: [245, 186, 74], ansi16: ANSI16.brightYellow },
    selectedBg: [55, 45, 80],
    separator: [65, 65, 80],
    success: { base: [120, 230, 160], ansi16: ANSI16.green },
  },
  checklist: {
    row: { base: [115, 115, 140], ansi16: ANSI16.white },
    rowChecked: { base: [120, 230, 160], ansi16: ANSI16.green },
    rowFocused: [210, 210, 225],
    rowFocusedBg: [26, 42, 77],
    sectionLabel: [170, 170, 195],
    sectionRule: [60, 60, 100],
  },
  picker: {
    option: [170, 170, 195],
    optionFocused: [210, 210, 225],
    optionSelected: { base: [120, 230, 160], ansi16: ANSI16.green },
    focusIndicator: [210, 210, 225],
    selectedIndicator: { base: [120, 230, 160], ansi16: ANSI16.green },
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

export const LIGHT_THEME: ThemeTokens = {
  copy: {
    body: [0, 0, 0],
    supporting: [45, 45, 70],
    note: [105, 105, 130],
    unavailable: [175, 175, 195],
    link: [25, 90, 190],
    pop: [255, 165, 50],
    success: [15, 125, 55],
  },
  dialog: {
    status: [0, 0, 0],
    prompt: [0, 0, 0],
    outputLabel: [105, 105, 130],
    outputText: [45, 45, 70],
    explanation: [105, 105, 130],
    plan: [25, 90, 190],
    foldIndicator: { fg: [45, 45, 70], bg: [210, 215, 230] },
    composePill: { fg: [15, 125, 55], bg: [215, 238, 220] },
  },
  input: {
    surface: [218, 232, 250],
    text: [0, 0, 0],
    placeholder: [105, 105, 130],
    editorStatus: [105, 105, 130],
  },
  actionBar: {
    label: [105, 105, 130],
    selected: [0, 0, 0],
    shortcut: [45, 45, 70],
    shortcutPrimary: [255, 165, 50],
    selectedShortcut: [0, 0, 0],
    selectedShortcutPrimary: [255, 165, 50],
    selectedBg: [220, 215, 238],
    separator: [175, 175, 195],
    success: [15, 125, 55],
  },
  checklist: {
    row: [105, 105, 130],
    rowChecked: [15, 125, 55],
    rowFocused: [0, 0, 0],
    rowFocusedBg: [210, 220, 245],
    sectionLabel: [45, 45, 70],
    sectionRule: [170, 170, 195],
  },
  picker: {
    option: [45, 45, 70],
    optionFocused: [0, 0, 0],
    optionSelected: [15, 125, 55],
    focusIndicator: [0, 0, 0],
    selectedIndicator: [15, 125, 55],
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

/** Hex for Ink color props. Pre-quantize because Ink emits truecolor escapes
 *  regardless of `FORCE_COLOR`. */
export function themeHex(c: ColorRef): string {
  const level = colorLevel();
  return colorHex(quantizeColor(themeColor(c, level), level));
}

/** Pick the RGB tuple for `level` — override if matching, else base. For
 *  callers that need a tuple (e.g. `fgCode(...rgb, level)`), not a hex. */
export function themeColor(c: ColorRef, level: number = colorLevel()): Color {
  if (Array.isArray(c)) return c;
  if (level === 1 && c.ansi16) return c.ansi16;
  if (level === 2 && c.ansi256) return c.ansi256;
  return c.base;
}
