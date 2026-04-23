import { type Color, interpolate } from "../core/ansi.ts";
import { colorLevel } from "../core/output.ts";
import { getTheme, themeHex } from "../core/theme.ts";

// Below truecolor, per-cell interpolation bands. Collapse to neutral text color.
function gradientFallback(): string | null {
  return colorLevel() < 3 ? themeHex(getTheme().text.primary) : null;
}

export function interpolateGradient(index: number, total: number, stops: Color[]): string {
  const fallback = gradientFallback();
  if (fallback) return fallback;
  const t = total > 1 ? index / (total - 1) : 0;
  return themeHex(interpolate(stops, t));
}

export function gradientRow(totalWidth: number, stops: Color[]): string[] {
  const fallback = gradientFallback();
  if (fallback) return new Array(totalWidth).fill(fallback);
  const out = new Array<string>(totalWidth);
  const denom = totalWidth > 1 ? totalWidth - 1 : 1;
  for (let i = 0; i < totalWidth; i++) out[i] = themeHex(interpolate(stops, i / denom));
  return out;
}
