import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { bottomBorderSegments, interpolateGradient, topBorderSegments } from "../src/tui/border.ts";
import { getRiskPresets } from "../src/tui/risk-presets.ts";
import { seedTestConfig } from "./helpers.ts";

// Border gradients collapse to the signature color below truecolor. These
// tests exercise the interpolation math, so force the truecolor path.
let savedForceColor: string | undefined;
beforeAll(() => {
  savedForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  seedTestConfig();
});
afterAll(() => {
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
});

function plainText(segments: { text: string }[]): string {
  return segments.map((segment) => segment.text).join("");
}

function preset(level: "low" | "medium" | "high") {
  return getRiskPresets()[level];
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
    expect(badgeSeg?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
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

  test("low risk badge is styled with a background color", () => {
    const { stops, badge } = preset("low");
    const segs = topBorderSegments(60, stops, badge);
    const badgeSeg = segs.find((segment) => segment.text.includes("low"));
    expect(badgeSeg).toBeDefined();
    expect(badgeSeg?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
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

  test("plain mode pads badge with spaces and no edge glyphs", () => {
    const { stops, badge } = preset("medium");
    const text = plainText(topBorderSegments(60, stops, badge));
    expect(text).not.toContain("\uE0B6");
    expect(text).not.toContain("\uE0B4");
    expect(text).toContain(" ⚠ medium risk ");
  });

  describe("with nerd fonts enabled", () => {
    beforeAll(() => {
      seedTestConfig({ nerdFonts: true });
    });
    afterAll(() => {
      seedTestConfig();
    });

    test("wraps badge in Powerline curve edges", () => {
      const { stops, badge } = preset("medium");
      const text = plainText(topBorderSegments(60, stops, badge));
      expect(text).toContain("\uE0B6");
      expect(text).toContain("\uE0B4");
    });

    test("drops inner padding spaces since curve glyph supplies them", () => {
      const { stops, badge } = preset("medium");
      const text = plainText(topBorderSegments(60, stops, badge));
      expect(text).toContain("\uE0B6⚠ medium risk\uE0B4");
    });

    test("visual width matches requested width", () => {
      const { stops, badge } = preset("medium");
      const border = topBorderSegments(60, stops, badge);
      expect(stringWidth(plainText(border))).toBe(60);
    });
  });
});

describe("bottomBorderSegments", () => {
  const stops = preset("medium").stops;

  test("starts with ╰ and ends with ╯", () => {
    const border = bottomBorderSegments(60, stops);
    const visual = plainText(border);
    expect(visual).toMatch(/^╰/);
    expect(visual).toMatch(/╯$/);
  });

  test("visual width matches requested width", () => {
    const border = bottomBorderSegments(60, stops);
    expect(stringWidth(plainText(border))).toBe(60);
  });

  test("uses the gradient's end color throughout", () => {
    const border = bottomBorderSegments(60, stops);
    expect(border.every((segment) => segment.color === "#3c3c64")).toBe(true);
  });
});

describe("bottomBorderSegments with status", () => {
  const stops = preset("medium").stops;

  test("renders status text embedded in left side", () => {
    const border = bottomBorderSegments(60, stops, "⢎ Reticulating splines...");
    expect(plainText(border)).toContain("⢎ Reticulating splines...");
  });

  test("starts with ╰─ and ends with ╯", () => {
    const border = bottomBorderSegments(60, stops, "⢎ Loading");
    const visual = plainText(border);
    expect(visual).toMatch(/^╰─/);
    expect(visual).toMatch(/╯$/);
  });

  test("visual width matches requested width", () => {
    const border = bottomBorderSegments(60, stops, "⢎ Loading");
    expect(stringWidth(plainText(border))).toBe(60);
  });

  test("status text is rendered in white, dashes/corners stay dim", () => {
    const border = bottomBorderSegments(60, stops, "⢎ Loading");
    const statusSegment = border.find((s) => s.text.includes("Loading"));
    expect(statusSegment).toBeDefined();
    expect(statusSegment?.color).toBe("#d2d2e1");
    const left = border.find((s) => s.text === "╰");
    const right = border.find((s) => s.text === "╯");
    expect(left?.color).toBe("#3c3c64");
    expect(right?.color).toBe("#3c3c64");
  });

  test("width stays constant across different status lengths", () => {
    const short = bottomBorderSegments(60, stops, "⢎ Hi");
    const long = bottomBorderSegments(60, stops, "⢎ Reticulating splines...");
    expect(stringWidth(plainText(short))).toBe(60);
    expect(stringWidth(plainText(long))).toBe(60);
  });

  test("truncates status with ellipsis when it does not fit at full length", () => {
    const border = bottomBorderSegments(20, stops, "⢎ Reticulating splines...");
    const visual = plainText(border);
    expect(stringWidth(visual)).toBe(20);
    expect(visual).toContain("…");
    expect(visual).toMatch(/^╰─/);
    expect(visual).toMatch(/╯$/);
    expect(visual).toContain("⢎ ");
  });

  test("falls back to plain border when even one ellipsis cannot fit", () => {
    const border = bottomBorderSegments(7, stops, "⢎ Reticulating splines...");
    expect(stringWidth(plainText(border))).toBe(7);
    expect(plainText(border)).not.toContain("…");
    expect(plainText(border)).not.toContain("Reticulating");
  });
});
