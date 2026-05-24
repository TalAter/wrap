import type { Color } from "wrap-core/ansi";
import type { PillSegment } from "wrap-core/tui";
import type { RiskLevel } from "../command-response.schema.ts";
import { getWrapTheme } from "./hooks.ts";

type RiskPreset = { stops: Color[]; pill: PillSegment };

// Call at render time — setTheme must have run.
export function getRiskPreset(level: RiskLevel): RiskPreset {
  const t = getWrapTheme();
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
