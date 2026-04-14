import stringWidth from "string-width";
import { type Color, interpolate } from "../core/ansi.ts";
import { colorLevel } from "../core/output.ts";
import { getTheme, themeHex } from "../core/theme.ts";

export type Badge = { fg: Color; bg: Color; icon: string; label: string };

export type BorderSegment = {
  key: string;
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
};

export function interpolateGradient(index: number, total: number, stops: Color[]): string {
  // Below truecolor, interpolating across many quantized cells produces
  // chunky banding. Collapse to the terminal's default text color (near
  // white on dark, near black on light) for a neutral uniform border.
  if (colorLevel() < 3) return themeHex(getTheme().text.primary);
  const t = total > 1 ? index / (total - 1) : 0;
  return themeHex(interpolate(stops, t));
}

export function topBorderSegments(
  totalWidth: number,
  stops: Color[],
  badge?: Badge,
): BorderSegment[] {
  // Custom instead of Ink's built-in border so we can style each glyph and
  // embed a styled badge inside the top rule.
  const badgeText = badge ? ` ${badge.icon} ${badge.label} ` : "";
  const badgeVisualWidth = badge ? stringWidth(badgeText) : 0;
  // Badge position: totalWidth - badgeVisualWidth - 3 (space + ─ + ╮)
  const badgeStart = badge ? totalWidth - badgeVisualWidth - 3 : -1;

  const segments: BorderSegment[] = [];
  for (let i = 0; i < totalWidth; ) {
    const color = interpolateGradient(i, totalWidth, stops);

    if (i === 0) {
      segments.push({ key: `top-${i}`, text: "╭", color });
      i += 1;
    } else if (i === totalWidth - 1) {
      segments.push({ key: `top-${i}`, text: "╮", color });
      i += 1;
    } else if (badge && (i === badgeStart - 1 || i === badgeStart + badgeVisualWidth)) {
      segments.push({ key: `top-${i}`, text: " ", color });
      i += 1;
    } else if (badge && i === badgeStart) {
      segments.push({
        key: `top-${i}`,
        text: badgeText,
        color: themeHex(badge.fg),
        backgroundColor: themeHex(badge.bg),
        bold: true,
      });
      i += badgeVisualWidth;
    } else {
      segments.push({ key: `top-${i}`, text: "─", color });
      i += 1;
    }
  }

  return segments;
}

// Truncate to a target visual width (cell count), appending an ellipsis when
// the original is too wide. Returns null when even a 1-char ellipsis cannot fit.
function truncateToWidth(text: string, maxWidth: number): string | null {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth < 2) return null; // need at least 1 visible char + ellipsis
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
  // Padding (corners + 2 spaces + 1 leading dash) takes 5 cells, so the status
  // needs at least 1 trailing dash to keep the right corner from collapsing.
  // Spaces around the status live on the dim segments, not the white one,
  // so the bright bar doesn't extend beyond the visible label.
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
