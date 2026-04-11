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

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function interpolate(stops: Color[], t: number): Color {
  if (stops.length === 1) return stops[0] as Color;
  const segments = stops.length - 1;
  const seg = Math.min(Math.floor(t * segments), segments - 1);
  const segT = t * segments - seg;
  const from = stops[seg] as Color;
  const to = stops[seg + 1] as Color;
  return [lerp(from[0], to[0], segT), lerp(from[1], to[1], segT), lerp(from[2], to[2], segT)];
}

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

/** SGR foreground escape for the given color at the given level (default truecolor). */
export function fgCode(r: number, g: number, b: number, level = 3): string {
  if (level <= 0) return "";
  if (level >= 3) return `${ESC}38;2;${r};${g};${b}m`;
  if (level === 2) return `${ESC}38;5;${to256(r, g, b)}m`;
  return `${ESC}${nearest16(r, g, b)}m`;
}

export function gradient(
  text: string,
  stops: Color[],
  shinePos?: number,
  shineRadius = 4,
  level = 3,
): string {
  if (text.length === 0) return "";
  if (level <= 0) return text;
  let result = "";
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text[i] === " ") {
      result += " ";
      continue;
    }
    const t = len > 1 ? i / (len - 1) : 0;
    let [r, g, b] = interpolate(stops, t);

    if (shinePos !== undefined) {
      const dist = Math.abs(i - shinePos);
      if (dist < shineRadius) {
        const boost = (1 - dist / shineRadius) ** 2;
        r = lerp(r, 255, boost);
        g = lerp(g, 255, boost);
        b = lerp(b, 255, boost);
      }
    }

    result += `${fgCode(r, g, b, level)}${text[i]}`;
  }
  if (result !== "") result += RESET;
  return result;
}
