import type { RiskLevel } from "../command-response.schema.ts";
import type { Color } from "../core/ansi.ts";
import { getTheme, type ThemeTokens } from "../core/theme.ts";
import type { Badge } from "./border.ts";

type RiskPreset = { stops: Color[]; badge: Badge };

// Badge backgrounds are derived by mixing the badge fg toward the theme dim.
function badgeBg(fg: Color, dim: Color): Color {
  return [
    Math.round(fg[0] * 0.3 + dim[0] * 0.7),
    Math.round(fg[1] * 0.3 + dim[1] * 0.7),
    Math.round(fg[2] * 0.3 + dim[2] * 0.7),
  ];
}

function buildPresets(t: ThemeTokens): Record<RiskLevel, RiskPreset> {
  return {
    low: {
      stops: t.gradient.riskLow,
      badge: {
        fg: t.status.success,
        bg: badgeBg(t.status.success, t.gradient.dim),
        icon: "✔",
        label: "low risk",
      },
    },
    medium: {
      stops: t.gradient.riskMed,
      badge: {
        fg: t.status.warning,
        bg: badgeBg(t.status.warning, t.gradient.dim),
        icon: "⚠",
        label: "medium risk",
      },
    },
    high: {
      stops: t.gradient.riskHigh,
      badge: {
        fg: t.status.error,
        bg: badgeBg(t.status.error, t.gradient.dim),
        icon: "⚠",
        label: "high risk",
      },
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
