import { afterEach, describe, expect, test } from "bun:test";
import {
  stepIndexFromScreen,
  wizardCrumbPill,
  wizardCrumbPillNarrow,
  wizardLabelPill,
} from "../src/tui/wizard-chrome.tsx";
import { seedTestConfig } from "./helpers.ts";

afterEach(() => {
  seedTestConfig();
});

describe("stepIndexFromScreen", () => {
  test("Providers step (index 0) for selection + loading", () => {
    expect(stepIndexFromScreen("selecting-providers")).toBe(0);
    expect(stepIndexFromScreen("loading-models")).toBe(0);
  });

  test("API Key step (index 1) for key entry + CLI disclaimer", () => {
    expect(stepIndexFromScreen("entering-key")).toBe(1);
    expect(stepIndexFromScreen("disclaimer")).toBe(1);
  });

  test("Model step (index 2) for model picker", () => {
    expect(stepIndexFromScreen("picking-model")).toBe(2);
  });

  test("Default step (index 3) for default picker", () => {
    expect(stepIndexFromScreen("picking-default")).toBe(3);
  });

  test("done points past the last step", () => {
    expect(stepIndexFromScreen("done")).toBe(4);
  });
});

describe("wizardLabelPill", () => {
  test("returns a single 🧙 Setup Wizard pill", () => {
    const segs = wizardLabelPill();
    expect(segs.length).toBe(1);
    expect(segs[0]?.label).toContain("🧙 Setup Wizard");
    expect(segs[0]?.bold).toBe(true);
  });
});

describe("wizardCrumbPill", () => {
  test("nerd + stepIndex 0 shows wizard + active Providers with icon", () => {
    const segs = wizardCrumbPill(0, true);
    expect(segs.length).toBe(2);
    expect(segs[0]?.label).toContain("🧙 Setup Wizard");
    expect(segs[1]?.label).toContain("Providers");
    expect(segs[1]?.label).toContain("\uF03A"); // ICON_LIST
    expect(segs[1]?.bold).toBe(true);
  });

  test("plain + stepIndex 0 omits nerd icon on active", () => {
    const segs = wizardCrumbPill(0, false);
    expect(segs[1]?.label).toBe("Providers");
    expect(segs[1]?.label).not.toContain("\uF03A");
  });

  test("nerd done step uses CHECK + step icon", () => {
    const segs = wizardCrumbPill(2, true);
    expect(segs.length).toBe(4); // wizard + 2 done + 1 active
    expect(segs[1]?.label).toBe("\uF00C \uF03A Providers");
    expect(segs[2]?.label).toBe("\uF00C \uF084 API Key");
    expect(segs[3]?.label).toContain("Model");
  });

  test("plain done step uses ✓ prefix", () => {
    const segs = wizardCrumbPill(2, false);
    expect(segs[1]?.label).toBe("✓ Providers");
    expect(segs[2]?.label).toBe("✓ API Key");
    expect(segs[3]?.label).toBe("Model");
  });

  test("stepIndex past last shows all done, no active", () => {
    const segs = wizardCrumbPill(4, false);
    expect(segs.length).toBe(5); // wizard + 4 done
    for (let i = 1; i <= 4; i++) {
      expect(segs[i]?.label.startsWith("✓")).toBe(true);
    }
  });

  test("each non-wizard segment carries a single-char labelNarrow", () => {
    const segs = wizardCrumbPill(3, false);
    // Skip wizard (index 0); rest should have narrow labels.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]?.labelNarrow?.length).toBe(1);
    }
  });

  test("active step segment is bold", () => {
    const segs = wizardCrumbPill(1, false);
    const active = segs[segs.length - 1];
    expect(active?.bold).toBe(true);
  });
});

describe("wizardCrumbPillNarrow", () => {
  test("drops the 'Setup Wizard' label segment", () => {
    const segs = wizardCrumbPillNarrow(1, true);
    expect(segs.every((s) => !s.label.includes("Setup Wizard"))).toBe(true);
  });

  test("emits one segment per step (done + active + future)", () => {
    const segs = wizardCrumbPillNarrow(1, true);
    expect(segs.length).toBe(4); // Providers done, API Key active, Model future, Default future
  });

  test("nerd + stepIndex 1 — done=✓, active=icon+label, future=icon only", () => {
    const segs = wizardCrumbPillNarrow(1, true);
    expect(segs[0]?.label).toBe("\uF00C"); // done: check only
    expect(segs[1]?.label).toBe("\uF084 API Key"); // active: icon + label
    expect(segs[1]?.bold).toBe(true);
    expect(segs[2]?.label).toBe("\uF1B2"); // future Model: icon only
    expect(segs[3]?.label).toBe("\uF005"); // future Default: icon only
  });

  test("plain + stepIndex 1 — done=✓, active=label, future=abbr", () => {
    const segs = wizardCrumbPillNarrow(1, false);
    expect(segs[0]?.label).toBe("✓");
    expect(segs[1]?.label).toBe("API Key");
    expect(segs[1]?.bold).toBe(true);
    expect(segs[2]?.label).toBe("M");
    expect(segs[3]?.label).toBe("D");
  });

  test("stepIndex 0 — no done, active first", () => {
    const segs = wizardCrumbPillNarrow(0, false);
    expect(segs.length).toBe(4);
    expect(segs[0]?.label).toBe("Providers");
    expect(segs[0]?.bold).toBe(true);
  });

  test("stepIndex past last — all done, no active/future", () => {
    const segs = wizardCrumbPillNarrow(4, false);
    expect(segs.length).toBe(4);
    for (const s of segs) expect(s.label).toBe("✓");
  });

  test("active step has labelNarrow for ultra-tight fits", () => {
    const segs = wizardCrumbPillNarrow(1, false);
    expect(segs[1]?.labelNarrow).toBe("K");
  });
});
