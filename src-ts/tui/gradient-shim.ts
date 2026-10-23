import {
  type Color,
  colorHex,
  colorLevel,
  interpolate,
  quantizeColor,
  resolveColorHex,
} from "wrap-core/ansi";
import { getTheme } from "wrap-core/theme";

/** Gradient color for a row index. Falls back to copy.body below truecolor. */
export function interpolateGradient(index: number, total: number, stops: readonly Color[]): string {
  const level = colorLevel();
  if (level < 3) return resolveColorHex(getTheme().copy.body);
  const t = total > 1 ? index / (total - 1) : 0;
  const c = interpolate(stops, t);
  return colorHex(quantizeColor(c, level));
}

/** Array of hex colors for each column position. Falls back to copy.body below truecolor. */
export function gradientRow(totalWidth: number, stops: readonly Color[]): string[] {
  const level = colorLevel();
  const fallback = level < 3 ? resolveColorHex(getTheme().copy.body) : null;
  if (fallback) return new Array(totalWidth).fill(fallback);
  const out = new Array<string>(totalWidth);
  const denom = totalWidth > 1 ? totalWidth - 1 : 1;
  for (let i = 0; i < totalWidth; i++) {
    const c = interpolate(stops, i / denom);
    out[i] = colorHex(quantizeColor(c, level));
  }
  return out;
}
