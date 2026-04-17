import stringWidth from "string-width";
import { type Color, interpolate } from "../core/ansi.ts";
import { colorLevel } from "../core/output.ts";
import { getTheme, themeHex } from "../core/theme.ts";
import { type BorderSegment, type PillSegment, pillSegments, pillWidth } from "./pill.tsx";

export type { BorderSegment } from "./pill.tsx";

export type TopBadge = {
  segs: PillSegment[];
  // Alternate shape used when `segs` can't fit the border at full labels.
  // Prefer a structurally simpler pill (fewer/shorter segments) over shrinking
  // `segs` via `labelNarrow`, since drastic narrowing loses information.
  narrowSegs?: PillSegment[];
  align: "left" | "right";
};

export type PreparedTop = {
  segments: BorderSegment[];
  align: "left" | "right";
  width: number;
};

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

// Returns pre-rendered segments so the border doesn't recompute width.
// `fullWidth` skips the full pillWidth call if the caller already has it.
export function fitTop(
  top: TopBadge | undefined,
  budget: number,
  nerd: boolean,
  fullWidth?: number,
): PreparedTop | undefined {
  if (!top || top.segs.length === 0) return undefined;
  const full = fullWidth ?? pillWidth(top.segs, nerd, false);
  if (full <= budget) {
    return { segments: pillSegments(top.segs, nerd, false), align: top.align, width: full };
  }
  // narrowSegs (if provided) is a redesigned compact pill — prefer it over
  // shrinking the wide pill's own labels, which loses structural context.
  const candidates = top.narrowSegs?.length ? [top.narrowSegs] : [top.segs];
  for (const segs of candidates) {
    for (const narrow of [false, true]) {
      if (narrow === false && segs === top.segs) continue; // already tried above
      const w = pillWidth(segs, nerd, narrow);
      if (w <= budget) {
        return { segments: pillSegments(segs, nerd, narrow), align: top.align, width: w };
      }
    }
  }
  return undefined;
}

// Custom border (not Ink's) so we can style each glyph and embed pills inside the rule.
export function topBorderSegments(
  totalWidth: number,
  stops: Color[],
  prepared?: PreparedTop,
): BorderSegment[] {
  if (totalWidth <= 0) return [];
  const colors = gradientRow(totalWidth, stops);
  const pillW = prepared?.width ?? 0;
  // Pills get 1-cell breathing room from each corner so they don't bump into ╭/╮.
  const pillStart = !prepared ? 1 : prepared.align === "right" ? totalWidth - 2 - pillW : 2;

  const out: BorderSegment[] = [];
  out.push({ key: "top-0", text: "╭", color: colors[0] });
  if (totalWidth === 1) return out;

  let col = 1;
  while (col < pillStart && col < totalWidth - 1) {
    out.push({ key: `top-${col}`, text: "─", color: colors[col] });
    col++;
  }
  if (prepared) {
    prepared.segments.forEach((seg, k) => {
      out.push({ ...seg, key: `top-pill-${k}` });
    });
    col += pillW;
  }
  while (col < totalWidth - 1) {
    out.push({ key: `top-${col}`, text: "─", color: colors[col] });
    col++;
  }
  out.push({ key: `top-${totalWidth - 1}`, text: "╮", color: colors[totalWidth - 1] });
  return out;
}

// Truncate to a target visual width (cell count), appending an ellipsis when
// the original is too wide. Returns null when even a 1-char ellipsis cannot fit.
function truncateToWidth(text: string, maxWidth: number): string | null {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth < 2) return null;
  let cut = text;
  while (cut.length > 0 && stringWidth(cut) + 1 > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut.length > 0 ? `${cut}…` : null;
}

export function bottomBorderSegments(
  totalWidth: number,
  stops: Color[],
  status?: string,
): BorderSegment[] {
  // Bottom matches the gradient's end so the four sides read as one frame.
  const color = interpolateGradient(stops.length - 1, stops.length, stops);
  const statusColor = themeHex(getTheme().text.primary);

  if (totalWidth <= 1) {
    return [{ key: "bottom-left", text: "╰", color }];
  }

  // Layout when status fits: ╰─ <status> ─...─╯
  // Padding (corners + 2 spaces + 1 leading dash) takes 5 cells; status needs
  // at least 1 trailing dash so the right corner doesn't collapse. Spaces
  // around the status stay dim so the bright bar matches the label's extent.
  if (status) {
    const maxStatusWidth = totalWidth - 6;
    const fitted = truncateToWidth(status, maxStatusWidth);
    if (fitted) {
      const trailingDashes = totalWidth - 5 - stringWidth(fitted);
      return [
        { key: "bottom-left", text: "╰", color },
        { key: "bottom-mid-lead", text: "─ ", color },
        { key: "bottom-status", text: fitted, color: statusColor },
        { key: "bottom-mid-tail", text: ` ${"─".repeat(trailingDashes)}`, color },
        { key: "bottom-right", text: "╯", color },
      ];
    }
  }

  return [
    { key: "bottom-left", text: "╰", color },
    { key: "bottom-mid", text: "─".repeat(Math.max(0, totalWidth - 2)), color },
    { key: "bottom-right", text: "╯", color },
  ];
}
