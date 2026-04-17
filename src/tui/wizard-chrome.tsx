import { Text } from "ink";
import { getTheme, type ThemeTokens, themeHex } from "../core/theme.ts";
import type { ProviderScreen } from "../wizard/state.ts";
import type { PillSegment } from "./pill.tsx";

export function getWizardStops() {
  return getTheme().gradient.wizard;
}

export const WIZARD_CONTENT_WIDTH = 70;

const ICON_CHECK = "\uF00C";
const ICON_LIST = "\uF03A";
const ICON_KEY = "\uF084";
const ICON_CUBE = "\uF1B2";
const ICON_STAR = "\uF005";

type StepDef = { key: string; icon: string; label: string; abbr: string };

const WIZARD_STEPS: readonly StepDef[] = [
  { key: "providers", icon: ICON_LIST, label: "Providers", abbr: "P" },
  { key: "apikey", icon: ICON_KEY, label: "API Key", abbr: "K" },
  { key: "model", icon: ICON_CUBE, label: "Model", abbr: "M" },
  { key: "default", icon: ICON_STAR, label: "Default", abbr: "D" },
] as const;

// disclaimer sits on API Key because it's the claude-code auth step; per-provider
// loop may skip entirely (ollama has no key; claude-code has no model picker).
export function stepIndexFromScreen(tag: ProviderScreen["tag"]): number {
  switch (tag) {
    case "selecting-providers":
    case "loading-models":
      return 0;
    case "entering-key":
    case "disclaimer":
      return 1;
    case "picking-model":
      return 2;
    case "picking-default":
      return 3;
    case "done":
      return WIZARD_STEPS.length;
  }
}

function wizardSeg(t: ThemeTokens): PillSegment {
  return { ...t.badge.wizard, fg: t.text.primary, label: "🧙 Setup Wizard", bold: true };
}

export function wizardLabelPill(): PillSegment[] {
  return [wizardSeg(getTheme())];
}

export function wizardCrumbPill(stepIndex: number, nerd: boolean): PillSegment[] {
  const t = getTheme();
  const segs: PillSegment[] = [wizardSeg(t)];
  const doneSteps = WIZARD_STEPS.slice(0, Math.max(0, stepIndex));
  const activeStep = WIZARD_STEPS[stepIndex];

  for (const step of doneSteps) {
    const label = nerd ? `${ICON_CHECK} ${step.icon} ${step.label}` : `✓ ${step.label}`;
    segs.push({ ...t.badge.stepDone, label, labelNarrow: step.abbr });
  }
  if (activeStep) {
    const label = nerd ? `${activeStep.icon} ${activeStep.label}` : activeStep.label;
    segs.push({
      ...t.badge.stepActive,
      label,
      labelNarrow: activeStep.abbr,
      bold: true,
    });
  }
  return segs;
}

type HintItem = { combo: string; label: string; primary?: boolean };

export function KeyHints({ items }: { items: readonly HintItem[] }) {
  const t = getTheme();
  const divider = themeHex(t.text.disabled);
  const highlight = themeHex(t.interactive.highlight);
  const secondary = themeHex(t.text.secondary);
  const muted = themeHex(t.text.muted);

  return (
    <Text>
      <Text>{"  "}</Text>
      {items.map((item, i) => (
        <Text key={item.combo}>
          {i > 0 ? <Text color={divider}>{"  │  "}</Text> : null}
          <Text bold color={item.primary ? highlight : secondary}>
            {item.combo}
          </Text>
          <Text color={muted}>{` ${item.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
