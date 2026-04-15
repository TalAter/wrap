import type { RiskLevel } from "../command-response.schema.ts";
import type { Color } from "../core/ansi.ts";
import { getTheme, type ThemeTokens } from "../core/theme.ts";
import type { Badge } from "./border.ts";

type RiskPreset = { stops: Color[]; badge: Badge };

function buildPresets(t: ThemeTokens): Record<RiskLevel, RiskPreset> {
  return {
    low: {
      stops: t.gradient.riskLow,
      badge: { ...t.badge.riskLow, icon: "✔", label: "low risk" },
    },
    medium: {
      stops: t.gradient.riskMedium,
      badge: { ...t.badge.riskMedium, icon: "⚠", label: "medium risk" },
    },
    high: {
      stops: t.gradient.riskHigh,
      badge: { ...t.badge.riskHigh, icon: "⚠", label: "high risk" },
    },
  };
}

/**
 * Per-risk-level gradient stops + badge, derived from the active theme.
 * Call at render time (after setTheme has run).
 */
export function getRiskPresets(): Record<RiskLevel, RiskPreset> {
  return buildPresets(getTheme());
}
