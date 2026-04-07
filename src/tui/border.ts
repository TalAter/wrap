import stringWidth from "string-width";
import type { RiskLevel } from "../command-response.schema.ts";
import { type Color, interpolate } from "../core/ansi.ts";

type Badge = { fg: Color; bg: Color; icon: string; label: string };

// Each risk level owns its gradient stops and its badge styling. Co-located so
// tuning a level's look only touches one place.
const RISK: Record<RiskLevel, { stops: Color[]; badge: Badge }> = {
  // Low risk: teal → blue → dim
  low: {
    stops: [
      [80, 220, 200],
      [70, 190, 195],
      [65, 160, 180],
      [60, 130, 160],
      [60, 95, 130],
      [60, 60, 100],
    ],
    badge: { fg: [120, 230, 160], bg: [25, 70, 40], icon: "✔", label: "low risk" },
  },
  // Medium risk: pink → purple → dim
  medium: {
    stops: [
      [255, 100, 200],
      [220, 100, 225],
      [160, 100, 250],
      [100, 100, 220],
      [70, 80, 150],
      [60, 60, 100],
    ],
    badge: { fg: [255, 200, 80], bg: [80, 60, 30], icon: "⚠", label: "medium risk" },
  },
  // High risk: red → purple → dim
  high: {
    stops: [
      [255, 60, 80],
      [230, 65, 130],
      [185, 75, 190],
      [125, 85, 210],
      [80, 80, 155],
      [60, 60, 100],
    ],
    badge: { fg: [255, 100, 100], bg: [80, 25, 25], icon: "⚠", label: "high risk" },
  },
};

const DIM_COLOR: Color = [60, 60, 100];

export type BorderSegment = {
  key: string;
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
};

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function colorHex([r, g, b]: Color): string {
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function interpolateGradient(index: number, total: number, riskLevel: RiskLevel): string {
  const t = total > 1 ? index / (total - 1) : 0;
  const [r, g, b] = interpolate(RISK[riskLevel].stops, t);
  return colorHex([r, g, b]);
}

export function topBorderSegments(totalWidth: number, riskLevel: RiskLevel): BorderSegment[] {
  // This stays custom instead of Ink's built-in border so we can style each glyph and embed the risk badge in the border itself.
  const { badge } = RISK[riskLevel];
  const badgeText = ` ${badge.icon} ${badge.label} `;
  const badgeVisualWidth = stringWidth(badgeText);
  // Badge position: totalWidth - badgeVisualWidth - 3 (space + ─ + ╮)
  const badgeStart = totalWidth - badgeVisualWidth - 3;

  const segments: BorderSegment[] = [];
  for (let i = 0; i < totalWidth; ) {
    const color = interpolateGradient(i, totalWidth, riskLevel);

    if (i === 0) {
      segments.push({ key: `top-${i}`, text: "╭", color });
      i += 1;
    } else if (i === totalWidth - 1) {
      segments.push({ key: `top-${i}`, text: "╮", color });
      i += 1;
    } else if (i === badgeStart - 1 || i === badgeStart + badgeVisualWidth) {
      segments.push({ key: `top-${i}`, text: " ", color });
      i += 1;
    } else if (i === badgeStart) {
      segments.push({
        key: `top-${i}`,
        text: badgeText,
        color: colorHex(badge.fg),
        backgroundColor: colorHex(badge.bg),
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

export function bottomBorderSegments(totalWidth: number, status?: string): BorderSegment[] {
  const color = colorHex(DIM_COLOR);

  if (totalWidth <= 1) {
    return [{ key: "bottom-left", text: "╰", color }];
  }

  // Layout when status fits: ╰─ <status> ─...─╯
  // Padding (corners + 2 spaces + 1 leading dash) takes 5 cells, so the status
  // needs at least 1 trailing dash to keep the right corner from collapsing.
  // The middle segment carries all whitespace inside one Text node so Ink
  // can't strip spaces at segment boundaries.
  if (status) {
    const maxStatusWidth = totalWidth - 6;
    const fitted = truncateToWidth(status, maxStatusWidth);
    if (fitted) {
      const trailingDashes = totalWidth - 5 - stringWidth(fitted);
      return [
        { key: "bottom-left", text: "╰", color },
        { key: "bottom-mid", text: `─ ${fitted} ${"─".repeat(trailingDashes)}`, color },
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
