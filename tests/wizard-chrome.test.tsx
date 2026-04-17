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
  test("stepIndex 0: wizard + active Providers, bold", () => {
    const segs = wizardCrumbPill(0, true);
    expect(segs.length).toBe(2);
    expect(segs[0]?.label).toContain("Setup Wizard");
    expect(segs[1]?.label).toContain("Providers");
    expect(segs[1]?.bold).toBe(true);
  });

  test("done segments get ✓ (plain) / CHECK glyph (nerd)", () => {
    expect(wizardCrumbPill(2, false)[1]?.label).toBe("✓ Providers");
    expect(wizardCrumbPill(2, true)[1]?.label).toContain("\uF00C");
  });

  test("past last: all done, no active", () => {
    const segs = wizardCrumbPill(4, false);
    expect(segs.length).toBe(5);
    expect(segs.at(-1)?.bold).toBeFalsy();
  });

  test("activeProvider replaces Providers segment; falls back to step icon when no nerdIcon", () => {
    const plain = wizardCrumbPill(2, false, { displayName: "Anthropic" });
    expect(plain[1]?.label).toBe("Anthropic"); // no ✓ — would imply provider is done

    const withIcon = wizardCrumbPill(2, true, { displayName: "Anthropic", nerdIcon: "\ue754" });
    expect(withIcon[1]?.label).toContain("Anthropic");
    expect(withIcon[1]?.label).toContain("\ue754");

    const noIcon = wizardCrumbPill(1, true, { displayName: "Ollama" });
    expect(noIcon[1]?.label).toContain("\uF03A"); // generic step icon fallback
  });

  test("activeProvider ignored when Providers not yet done", () => {
    expect(wizardCrumbPill(0, false, { displayName: "Anthropic" })[1]?.label).toBe("Providers");
  });

  test("Default step collapses to Providers + Set Default", () => {
    const segs = wizardCrumbPill(3, false);
    expect(segs.length).toBe(3);
    expect(segs[1]?.label).toBe("✓ Providers");
    expect(segs[2]?.label).toBe("Set Default");
    expect(segs[2]?.bold).toBe(true);
  });
});

describe("wizardCrumbPillNarrow", () => {
  test("one segment per step, no Setup Wizard segment", () => {
    const segs = wizardCrumbPillNarrow(1, true);
    expect(segs.length).toBe(4);
    expect(segs.every((s) => !s.label.includes("Setup Wizard"))).toBe(true);
  });

  test("done=✓, active=bold label, future=abbr (plain) / icon (nerd)", () => {
    const plain = wizardCrumbPillNarrow(1, false);
    expect(plain[0]?.label).toBe("✓");
    expect(plain[1]?.label).toBe("API Key");
    expect(plain[1]?.bold).toBe(true);
    expect(plain[2]?.label).toBe("M"); // future abbr

    const nerd = wizardCrumbPillNarrow(1, true);
    expect(nerd[2]?.label).toBe("\uF1B2"); // future icon
  });

  test("past last: all ✓, no active", () => {
    const segs = wizardCrumbPillNarrow(4, false);
    expect(segs.length).toBe(4);
    for (const s of segs) expect(s.label).toBe("✓");
  });
});
