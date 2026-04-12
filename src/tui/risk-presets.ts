import type { RiskLevel } from "../command-response.schema.ts";
import type { Color } from "../core/ansi.ts";
import type { Badge } from "./border.ts";

/**
 * Per-risk-level gradient stops + badge. Co-located so tuning a level's look
 * only touches one place. ResponseDialog picks the preset for the current
 * risk level and hands stops + badge into the generic <Dialog> chrome.
 */
export const RISK_PRESETS: Record<RiskLevel, { stops: Color[]; badge: Badge }> = {
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
