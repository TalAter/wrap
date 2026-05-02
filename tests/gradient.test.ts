import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __resetColorLevelCache } from "../src/core/output.ts";
import { getTheme, themeHex } from "../src/core/theme.ts";
import { gradientRow, interpolateGradient } from "../src/tui/gradient.ts";
import { getRiskPreset } from "../src/tui/risk-presets.ts";
import { isolateEnv, seedTestConfig } from "./helpers.ts";

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

describe("gradientRow", () => {
  test("returns N hex colors with per-cell variation", () => {
    const row = gradientRow(5, preset("medium").stops);
    expect(row).toHaveLength(5);
    for (const c of row) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(row[2]).not.toBe(row[0]);
  });

  test("first color matches start of medium palette", () => {
    expect(gradientRow(5, preset("medium").stops)[0]).toBe("#ff64c8");
  });

  test("last color matches end of medium palette (dim)", () => {
    const row = gradientRow(5, preset("medium").stops);
    expect(row[row.length - 1]).toBe("#3c3c64");
  });

  test("totalWidth=1 returns single first-stop color", () => {
    const row = gradientRow(1, preset("medium").stops);
    expect(row).toHaveLength(1);
    expect(row[0]).toBe("#ff64c8");
  });
});

// Below truecolor the gradient collapses to the primary text color. These
// tests force a non-truecolor level so the fallback branch executes.
describe("gradient fallback (below truecolor)", () => {
  isolateEnv(["FORCE_COLOR"]);
  beforeEach(() => {
    process.env.FORCE_COLOR = "2";
    __resetColorLevelCache();
  });
  afterEach(() => {
    __resetColorLevelCache();
  });

  test("interpolateGradient returns the primary text hex regardless of stops", () => {
    const expected = themeHex(getTheme().text.primary);
    expect(interpolateGradient(0, 10, preset("medium").stops)).toBe(expected);
    expect(interpolateGradient(5, 10, preset("high").stops)).toBe(expected);
  });

  test("gradientRow returns a row of primary text hex of the requested length", () => {
    const expected = themeHex(getTheme().text.primary);
    const row = gradientRow(4, preset("medium").stops);
    expect(row).toHaveLength(4);
    expect(row.every((c) => c === expected)).toBe(true);
  });
});
