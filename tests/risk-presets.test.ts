import { afterEach, describe, expect, test } from "bun:test";
import { DARK_CORE, LIGHT_CORE, setTheme } from "wrap-core/theme";
import { DARK_THEME, LIGHT_THEME } from "../src/core/theme.ts";
import { getRiskPreset } from "../src/tui/risk-presets.ts";

// risk.medium/high are now derived from wrap-core's `severity.warning/danger`.
// These pin the wiring (medium←severity.warning, high←severity.danger) against
// core's source of truth — not core's literal RGB values, which can retune.
// Labels are wrap-local, so they stay asserted as literals.

afterEach(() => {
  setTheme(DARK_THEME);
});

describe("getRiskPreset — derives medium/high from core severity", () => {
  test("dark: medium = warning palette, high = danger palette", () => {
    setTheme(DARK_THEME);

    const medium = getRiskPreset("medium");
    expect(medium.pill.label).toBe("⚠ medium risk");
    expect(medium.pill.fg).toEqual(DARK_CORE.severity.warning.pill.fg);
    expect(medium.pill.bg).toEqual(DARK_CORE.severity.warning.pill.bg);
    expect(medium.stops).toEqual(DARK_CORE.severity.warning.frame);

    const high = getRiskPreset("high");
    expect(high.pill.label).toBe("⚠ high risk");
    expect(high.pill.fg).toEqual(DARK_CORE.severity.danger.pill.fg);
    expect(high.pill.bg).toEqual(DARK_CORE.severity.danger.pill.bg);
    expect(high.stops).toEqual(DARK_CORE.severity.danger.frame);
  });

  test("light: medium/high read the active light palette (differ from dark)", () => {
    setTheme(LIGHT_THEME);

    const medium = getRiskPreset("medium");
    expect(medium.pill.fg).toEqual(LIGHT_CORE.severity.warning.pill.fg);
    expect(medium.pill.bg).toEqual(LIGHT_CORE.severity.warning.pill.bg);
    expect(medium.stops).toEqual(LIGHT_CORE.severity.warning.frame);

    const high = getRiskPreset("high");
    expect(high.pill.fg).toEqual(LIGHT_CORE.severity.danger.pill.fg);
    expect(high.pill.bg).toEqual(LIGHT_CORE.severity.danger.pill.bg);
    expect(high.stops).toEqual(LIGHT_CORE.severity.danger.frame);

    // Pins "reads the *active* theme," not just "reads *a* theme."
    expect(medium.pill.fg).not.toEqual(DARK_CORE.severity.warning.pill.fg);
  });
});
