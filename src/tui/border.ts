import stringWidth from "string-width";
import { type Color, interpolate } from "../core/ansi.ts";

// Medium risk: pink → purple → dim
const MEDIUM_STOPS: Color[] = [
  [255, 100, 200],
  [220, 100, 225],
  [160, 100, 250],
  [100, 100, 220],
  [70, 80, 150],
  [60, 60, 100],
];

// High risk: red → purple → dim
const HIGH_STOPS: Color[] = [
  [255, 60, 80],
  [230, 65, 130],
  [185, 75, 190],
  [125, 85, 210],
  [80, 80, 155],
  [60, 60, 100],
];

const DIM_COLOR: Color = [60, 60, 100];

// Badge colors per risk level
const BADGE = {
  medium: { fg: [255, 200, 80] as Color, bg: [80, 60, 30] as Color },
  high: { fg: [255, 100, 100] as Color, bg: [80, 25, 25] as Color },
};

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

export function interpolateGradient(
  index: number,
  total: number,
  riskLevel: "medium" | "high",
): string {
  const t = total > 1 ? index / (total - 1) : 0;
  const stops = riskLevel === "medium" ? MEDIUM_STOPS : HIGH_STOPS;
  const [r, g, b] = interpolate(stops, t);
  return colorHex([r, g, b]);
}

export function topBorderSegments(
  totalWidth: number,
  riskLevel: "medium" | "high",
): BorderSegment[] {
  // This stays custom instead of Ink's built-in border so we can style each glyph and embed the risk badge in the border itself.
  const badgeText = ` ⚠ ${riskLevel} `;
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
        color: colorHex(BADGE[riskLevel].fg),
        backgroundColor: colorHex(BADGE[riskLevel].bg),
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

export function bottomBorderSegments(totalWidth: number): BorderSegment[] {
  const color = colorHex(DIM_COLOR);

  if (totalWidth <= 1) {
    return [{ key: "bottom-left", text: "╰", color }];
  }

  return [
    { key: "bottom-left", text: "╰", color },
    { key: "bottom-mid", text: "─".repeat(Math.max(0, totalWidth - 2)), color },
    { key: "bottom-right", text: "╯", color },
  ];
}
