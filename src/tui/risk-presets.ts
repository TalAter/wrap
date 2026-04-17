import type { RiskLevel } from "../command-response.schema.ts";
import type { Color } from "../core/ansi.ts";
import { getTheme } from "../core/theme.ts";
import type { PillSegment } from "./pill.tsx";

type RiskPreset = { stops: Color[]; pill: PillSegment };

// Call at render time — setTheme must have run.
export function getRiskPreset(level: RiskLevel): RiskPreset {
  const t = getTheme();
  switch (level) {
    case "low":
      return {
        stops: t.gradient.riskLow,
        pill: { ...t.badge.riskLow, label: "✔ low risk", bold: true },
      };
    case "medium":
      return {
        stops: t.gradient.riskMedium,
        pill: { ...t.badge.riskMedium, label: "⚠ medium risk", bold: true },
      };
    case "high":
      return {
        stops: t.gradient.riskHigh,
        pill: { ...t.badge.riskHigh, label: "⚠ high risk", bold: true },
      };
  }
}
