import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __resetColorLevelCache } from "../src/core/output.ts";
import { interpolateGradient } from "../src/tui/gradient.ts";
import { getRiskPreset } from "../src/tui/risk-presets.ts";
import { seedTestConfig } from "./helpers.ts";

// Gradients collapse to the signature color below truecolor. These tests
// exercise the interpolation math, so force the truecolor path.
let savedForceColor: string | undefined;
beforeAll(() => {
  savedForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  __resetColorLevelCache();
  seedTestConfig();
});
afterAll(() => {
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
  __resetColorLevelCache();
});

function preset(level: "low" | "medium" | "high") {
  return getRiskPreset(level);
}

describe("interpolateGradient", () => {
  test("returns hex color string starting with #", () => {
    const color = interpolateGradient(0, 10, preset("medium").stops);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("first color matches start of medium palette", () => {
    expect(interpolateGradient(0, 10, preset("medium").stops)).toBe("#ff64c8");
  });

  test("last color matches end of palette (dim)", () => {
    expect(interpolateGradient(9, 10, preset("medium").stops)).toBe("#3c3c64");
  });

  test("first color matches start of high palette", () => {
    expect(interpolateGradient(0, 10, preset("high").stops)).toBe("#ff3c50");
  });

  test("first color matches start of low palette", () => {
    expect(interpolateGradient(0, 10, preset("low").stops)).toBe("#50dcc8");
  });

  test("low palette ends at the same dim color as the others", () => {
    expect(interpolateGradient(9, 10, preset("low").stops)).toBe("#3c3c64");
  });

  test("single element returns first stop", () => {
    expect(interpolateGradient(0, 1, preset("medium").stops)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
