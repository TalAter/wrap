import { getTheme, type ThemeTokens } from "../core/theme.ts";
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
  { key: "default", icon: ICON_STAR, label: "Set Default", abbr: "D" },
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
  return { ...t.badge.wizard, label: "🧙 Setup Wizard", bold: true };
}

export function wizardLabelPill(): PillSegment[] {
  return [wizardSeg(getTheme())];
}

// Narrow variant: drops the "Setup Wizard" label; shows all steps (done/active/future)
// so the user still sees where they are in the flow when the wide pill doesn't fit.
export function wizardCrumbPillNarrow(stepIndex: number, nerd: boolean): PillSegment[] {
  const t = getTheme();
  const segs: PillSegment[] = [];
  WIZARD_STEPS.forEach((step, i) => {
    if (i < stepIndex) {
      segs.push({ ...t.badge.stepDone, label: nerd ? ICON_CHECK : "✓" });
    } else if (i === stepIndex) {
      segs.push({
        ...t.badge.stepActive,
        label: nerd ? `${step.icon} ${step.label}` : step.label,
        labelNarrow: nerd ? step.icon : step.abbr,
        bold: true,
      });
    } else {
      segs.push({ ...t.badge.stepPending, label: nerd ? step.icon : step.abbr });
    }
  });
  return segs;
}

export type ActiveProvider = { displayName: string; nerdIcon?: string };

export function wizardCrumbPill(
  stepIndex: number,
  nerd: boolean,
  activeProvider?: ActiveProvider,
): PillSegment[] {
  const t = getTheme();
  const segs: PillSegment[] = [wizardSeg(t)];
  const activeStep = WIZARD_STEPS[stepIndex];
  // On the default-picker screen the per-provider key/model steps are noise —
  // show only Providers → Set Default so the crumb reads as a summary.
  const doneSteps =
    activeStep?.key === "default"
      ? WIZARD_STEPS.slice(0, Math.max(0, stepIndex)).filter((s) => s.key === "providers")
      : WIZARD_STEPS.slice(0, Math.max(0, stepIndex));

  for (const step of doneSteps) {
    const useProvider = step.key === "providers" && activeProvider;
    const stepLabel = useProvider ? activeProvider.displayName : step.label;
    const stepIcon = useProvider ? (activeProvider.nerdIcon ?? step.icon) : step.icon;
    let label: string;
    if (nerd) label = `${ICON_CHECK} ${stepIcon} ${stepLabel}`;
    else label = useProvider ? stepLabel : `✓ ${stepLabel}`;
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
