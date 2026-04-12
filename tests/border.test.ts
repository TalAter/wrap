import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { bottomBorderSegments, interpolateGradient, topBorderSegments } from "../src/tui/border.ts";
import { RISK_PRESETS } from "../src/tui/risk-presets.ts";

function plainText(segments: { text: string }[]): string {
  return segments.map((segment) => segment.text).join("");
}

function preset(level: "low" | "medium" | "high") {
  return RISK_PRESETS[level];
}

describe("interpolateGradient", () => {
  test("returns hex color string starting with #", () => {
    const color = interpolateGradient(0, 10, preset("medium").stops);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("first color matches start of medium palette", () => {
    // Medium starts at [255,100,200]
    const color = interpolateGradient(0, 10, preset("medium").stops);
    expect(color).toBe("#ff64c8");
  });

  test("last color matches end of palette (dim)", () => {
    // Both palettes end at [60,60,100]
    const color = interpolateGradient(9, 10, preset("medium").stops);
    expect(color).toBe("#3c3c64");
  });

  test("first color matches start of high palette", () => {
    // High starts at [255,60,80]
    const color = interpolateGradient(0, 10, preset("high").stops);
    expect(color).toBe("#ff3c50");
  });

  test("first color matches start of low palette", () => {
    // Low starts at [80,220,200]
    const color = interpolateGradient(0, 10, preset("low").stops);
    expect(color).toBe("#50dcc8");
  });

  test("low palette ends at the same dim color as the others", () => {
    expect(interpolateGradient(9, 10, preset("low").stops)).toBe("#3c3c64");
  });

  test("single element returns first stop", () => {
    const color = interpolateGradient(0, 1, preset("medium").stops);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("topBorderSegments", () => {
  test("contains risk badge text for medium", () => {
    const { stops, badge } = preset("medium");
    const border = topBorderSegments(60, stops, badge);
    expect(plainText(border)).toContain("medium");
  });

  test("contains risk badge text for high", () => {
    const { stops, badge } = preset("high");
    const border = topBorderSegments(60, stops, badge);
    expect(plainText(border)).toContain("high");
  });

  test("contains warning symbol", () => {
    const { stops, badge } = preset("medium");
    const border = topBorderSegments(60, stops, badge);
    expect(plainText(border)).toContain("⚠");
  });

  test("starts with rounded corner ╭", () => {
    const { stops, badge } = preset("medium");
    const border = topBorderSegments(60, stops, badge);
    expect(plainText(border)).toMatch(/^╭/);
  });

  test("ends with rounded corner ╮", () => {
    const { stops, badge } = preset("medium");
    const border = topBorderSegments(60, stops, badge);
    expect(plainText(border)).toMatch(/╮$/);
  });

  test("visual width matches requested width", () => {
    const { stops, badge } = preset("medium");
    const border = topBorderSegments(60, stops, badge);
    expect(stringWidth(plainText(border))).toBe(60);
  });

  test("renders badge as a styled segment", () => {
    const { stops, badge } = preset("medium");
    const segs = topBorderSegments(60, stops, badge);
    const badgeSeg = segs.find((segment) => segment.text.includes("medium"));
    expect(badgeSeg).toBeDefined();
    expect(badgeSeg?.backgroundColor).toBe("#503c1e");
    expect(badgeSeg?.bold).toBe(true);
  });

  test("low risk badge uses ✔ glyph and 'low risk' label", () => {
    const { stops, badge } = preset("low");
    const border = topBorderSegments(60, stops, badge);
    const text = plainText(border);
    expect(text).toContain("✔");
    expect(text).toContain("low risk");
    expect(text).not.toContain("⚠");
  });

  test("low risk badge is styled with the green/dim background", () => {
    const { stops, badge } = preset("low");
    const segs = topBorderSegments(60, stops, badge);
    const badgeSeg = segs.find((segment) => segment.text.includes("low"));
    expect(badgeSeg).toBeDefined();
    expect(badgeSeg?.backgroundColor).toBe("#194628");
    expect(badgeSeg?.bold).toBe(true);
  });

  test("low risk visual width matches requested width", () => {
    const { stops, badge } = preset("low");
    const border = topBorderSegments(60, stops, badge);
    expect(stringWidth(plainText(border))).toBe(60);
  });

  test("badge glyphs ⚠ and ✔ have matching visual width", () => {
    // Badge positioning math assumes a consistent glyph width across risk levels.
    expect(stringWidth("⚠")).toBe(stringWidth("✔"));
  });

  test("renders border without a badge when none is provided", () => {
    const { stops } = preset("medium");
    const border = topBorderSegments(60, stops);
    const text = plainText(border);
    expect(stringWidth(text)).toBe(60);
    expect(text).toMatch(/^╭/);
    expect(text).toMatch(/╮$/);
    expect(text).not.toContain("medium");
    expect(text).not.toContain("⚠");
  });
});

describe("bottomBorderSegments", () => {
  test("starts with ╰ and ends with ╯", () => {
    const border = bottomBorderSegments(60);
    const visual = plainText(border);
    expect(visual).toMatch(/^╰/);
    expect(visual).toMatch(/╯$/);
  });

  test("visual width matches requested width", () => {
    const border = bottomBorderSegments(60);
    expect(stringWidth(plainText(border))).toBe(60);
  });

  test("uses dim color throughout", () => {
    const border = bottomBorderSegments(60);
    expect(border.every((segment) => segment.color === "#3c3c64")).toBe(true);
  });
});

describe("bottomBorderSegments with status", () => {
  test("renders status text embedded in left side", () => {
    const border = bottomBorderSegments(60, "⢎ Reticulating splines...");
    expect(plainText(border)).toContain("⢎ Reticulating splines...");
  });

  test("starts with ╰─ and ends with ╯", () => {
    const border = bottomBorderSegments(60, "⢎ Loading");
    const visual = plainText(border);
    expect(visual).toMatch(/^╰─/);
    expect(visual).toMatch(/╯$/);
  });

  test("visual width matches requested width", () => {
    const border = bottomBorderSegments(60, "⢎ Loading");
    expect(stringWidth(plainText(border))).toBe(60);
  });

  test("status text is rendered in white, dashes/corners stay dim", () => {
    // The dim border color makes the status text hard to read against the
    // dialog background. The status segment must use a near-white color so
    // the spinner + label stand out, while the surrounding dashes stay dim.
    const border = bottomBorderSegments(60, "⢎ Loading");
    const statusSegment = border.find((s) => s.text.includes("Loading"));
    expect(statusSegment).toBeDefined();
    expect(statusSegment?.color).toBe("#d2d2e1");
    // Corner segments still dim.
    const left = border.find((s) => s.text === "╰");
    const right = border.find((s) => s.text === "╯");
    expect(left?.color).toBe("#3c3c64");
    expect(right?.color).toBe("#3c3c64");
  });

  test("width stays constant across different status lengths", () => {
    const short = bottomBorderSegments(60, "⢎ Hi");
    const long = bottomBorderSegments(60, "⢎ Reticulating splines...");
    expect(stringWidth(plainText(short))).toBe(60);
    expect(stringWidth(plainText(long))).toBe(60);
  });

  test("truncates status with ellipsis when it does not fit at full length", () => {
    // 24 cells leaves room for "⢎ Reticulati…" (13 cells) plus padding (5+1=6)
    const border = bottomBorderSegments(20, "⢎ Reticulating splines...");
    const visual = plainText(border);
    expect(stringWidth(visual)).toBe(20);
    expect(visual).toContain("…");
    expect(visual).toMatch(/^╰─/);
    expect(visual).toMatch(/╯$/);
    // The first piece of the status survives
    expect(visual).toContain("⢎ ");
  });

  test("falls back to plain border when even one ellipsis cannot fit", () => {
    // totalWidth too small for any status content — render unadorned border.
    const border = bottomBorderSegments(7, "⢎ Reticulating splines...");
    expect(stringWidth(plainText(border))).toBe(7);
    expect(plainText(border)).not.toContain("…");
    expect(plainText(border)).not.toContain("Reticulating");
  });
});
