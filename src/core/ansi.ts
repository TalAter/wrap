export type Color = [number, number, number];

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export const SHOW_CURSOR = `${ESC}?25h`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const ERASE_LINE = `${ESC}2K`;

export function bold(text: string): string {
  return `${ESC}1m${text}${RESET}`;
}

export function dim(text: string): string {
  return `${ESC}2m${text}${RESET}`;
}

/** Always truecolor — callers wanting adaptive output use fgCode(). */
export function fg(text: string, r: number, g: number, b: number): string {
  return `${fgCode(r, g, b, 3)}${text}${RESET}`;
}

export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function flerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// sRGB → linear → OKLAB (Björn Ottosson). OKLAB is perceptually uniform,
// so lerping there avoids the muddy mid-tones you get from raw RGB.
type Oklab = [number, number, number];

function srgbToLinear(c: number): number {
  const cn = c / 255;
  return cn <= 0.04045 ? cn / 12.92 : ((cn + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function rgbToOklab([r, g, b]: Color): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToRgb([L, a, b]: Oklab): Color {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

function lerpOklab(a: Oklab, b: Oklab, t: number): Oklab {
  return [flerp(a[0], b[0], t), flerp(a[1], b[1], t), flerp(a[2], b[2], t)];
}

function interpolateOklab(stops: readonly Color[], t: number): Oklab {
  if (stops.length === 1) return rgbToOklab(stops[0] as Color);
  const segments = stops.length - 1;
  const seg = Math.min(Math.floor(t * segments), segments - 1);
  const segT = t * segments - seg;
  return lerpOklab(rgbToOklab(stops[seg] as Color), rgbToOklab(stops[seg + 1] as Color), segT);
}

export function interpolate(stops: readonly Color[], t: number): Color {
  return oklabToRgb(interpolateOklab(stops, t));
}

const WHITE_OKLAB: Oklab = rgbToOklab([255, 255, 255]);

// Standard xterm 16-color palette as rendered by most terminals.
// Individual themes remap these, which is exactly the point — users
// who picked a palette get their palette back.
const ANSI16: Array<[Color, number]> = [
  [[0, 0, 0], 30],
  [[170, 0, 0], 31],
  [[0, 170, 0], 32],
  [[170, 85, 0], 33],
  [[0, 0, 170], 34],
  [[170, 0, 170], 35],
  [[0, 170, 170], 36],
  [[170, 170, 170], 37],
  [[85, 85, 85], 90],
  [[255, 85, 85], 91],
  [[85, 255, 85], 92],
  [[255, 255, 85], 93],
  [[85, 85, 255], 94],
  [[255, 85, 255], 95],
  [[85, 255, 255], 96],
  [[255, 255, 255], 97],
];

function nearest16(r: number, g: number, b: number): number {
  let best = 37;
  let bestDist = Infinity;
  for (const [[pr, pg, pb], code] of ANSI16) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = code;
    }
  }
  return best;
}

// The real xterm 6×6×6 cube levels, not an even split of 0–255.
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeIndex(v: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const d = Math.abs(v - (CUBE_LEVELS[i] as number));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function to256(r: number, g: number, b: number): number {
  // Grayscale ramp (232–255) is closer for near-neutral colors than the cube.
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 246) * 24) + 232;
  }
  const ri = nearestCubeIndex(r);
  const gi = nearestCubeIndex(g);
  const bi = nearestCubeIndex(b);
  return 16 + 36 * ri + 6 * gi + bi;
}

/** Convert an RGB tuple to a #rrggbb hex string for Ink color props. */
export function colorHex([r, g, b]: Color): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function idx256ToRgb(idx: number): Color {
  if (idx >= 232) {
    const v = 8 + (idx - 232) * 10;
    return [v, v, v];
  }
  const n = idx - 16;
  const ri = Math.floor(n / 36);
  const gi = Math.floor((n % 36) / 6);
  const bi = n % 6;
  return [CUBE_LEVELS[ri] as number, CUBE_LEVELS[gi] as number, CUBE_LEVELS[bi] as number];
}

function code16ToRgb(code: number): Color {
  for (const [rgb, c] of ANSI16) {
    if (c === code) return rgb;
  }
  return [0, 0, 0];
}

/**
 * Snap a color to the nearest representable RGB for the given level.
 * Level 3 and 0 pass through (no palette constraint). Level 2 uses the
 * xterm 256-color cube + grayscale. Level 1 uses the ANSI16 palette.
 *
 * Use this before handing a hex string to Ink: Ink's Text color prop
 * always emits truecolor escapes, which defeats FORCE_COLOR=1/2.
 */
export function quantizeColor(c: Color, level: number): Color {
  if (level >= 3 || level <= 0) return c;
  const [r, g, b] = c;
  if (level === 2) return idx256ToRgb(to256(r, g, b));
  return code16ToRgb(nearest16(r, g, b));
}

/** SGR foreground escape for the given color at the given level (default truecolor). */
export function fgCode(r: number, g: number, b: number, level = 3): string {
  if (level <= 0) return "";
  if (level >= 3) return `${ESC}38;2;${r};${g};${b}m`;
  if (level === 2) return `${ESC}38;5;${to256(r, g, b)}m`;
  return `${ESC}${nearest16(r, g, b)}m`;
}

/**
 * Per-cell rendering — each element is either a single space or an ANSI
 * SGR escape glued to its character. Diff-based repainters compare cells
 * directly to find the minimal dirty range per row.
 *
 * Below truecolor, the gradient is collapsed to the signature color (first
 * stop) because quantising an interpolation across 16 or 256 colors
 * produces chunky banding instead of a smooth ramp. Shine is also dropped
 * since it depends on blended whites that don't land in limited palettes.
 */
export function gradientCells(
  text: string,
  stops: readonly Color[],
  shinePos?: number,
  shineRadius = 4,
  level = 3,
): string[] {
  const len = text.length;
  if (len === 0) return [];
  const cells: string[] = new Array(len);
  const solid = level > 0 && level < 3 ? (stops[0] as Color) : null;
  const solidEsc = solid ? fgCode(solid[0], solid[1], solid[2], level) : "";

  for (let i = 0; i < len; i++) {
    const ch = text[i] as string;
    if (ch === " ") {
      cells[i] = " ";
      continue;
    }
    if (level <= 0) {
      cells[i] = ch;
      continue;
    }
    if (solid) {
      cells[i] = `${solidEsc}${ch}`;
      continue;
    }
    const t = len > 1 ? i / (len - 1) : 0;
    let lab = interpolateOklab(stops, t);

    if (shinePos !== undefined) {
      const dist = Math.abs(i - shinePos);
      if (dist < shineRadius) {
        const boost = (1 - dist / shineRadius) ** 2;
        lab = lerpOklab(lab, WHITE_OKLAB, boost);
      }
    }

    const [r, g, b] = oklabToRgb(lab);
    cells[i] = `${fgCode(r, g, b, level)}${ch}`;
  }
  return cells;
}

export function gradient(
  text: string,
  stops: readonly Color[],
  shinePos?: number,
  shineRadius = 4,
  level = 3,
): string {
  const cells = gradientCells(text, stops, shinePos, shineRadius, level);
  if (cells.length === 0) return "";
  if (level <= 0) return cells.join("");
  return cells.join("") + RESET;
}
