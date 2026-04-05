export type Color = [number, number, number];

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export const SHOW_CURSOR = `${ESC}?25h`;
export const HIDE_CURSOR = `${ESC}?25l`;

export function bold(text: string): string {
  return `${ESC}1m${text}${RESET}`;
}

export function dim(text: string): string {
  return `${ESC}2m${text}${RESET}`;
}

export function fg(text: string, r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m${text}${RESET}`;
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

export function gradient(text: string, stops: Color[], shinePos?: number, shineRadius = 4): string {
  if (text.length === 0) return "";
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

    result += `${ESC}38;2;${r};${g};${b}m${text[i]}`;
  }
  if (result !== "") result += RESET;
  return result;
}
