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
        stops: t.risk.low.frame,
        pill: { ...t.risk.low.pill, label: "✔ low risk", bold: true },
      };
    case "medium":
      return {
        stops: t.risk.medium.frame,
        pill: { ...t.risk.medium.pill, label: "⚠ medium risk", bold: true },
      };
    case "high":
      return {
        stops: t.risk.high.frame,
        pill: { ...t.risk.high.pill, label: "⚠ high risk", bold: true },
      };
  }
}
