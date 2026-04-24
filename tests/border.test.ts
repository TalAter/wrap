import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import {
  bottomBorderSegments,
  fitTop,
  type TopBadge,
  topBorderSegments,
} from "../src/tui/border.ts";
import { getRiskPreset } from "../src/tui/risk-presets.ts";
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
  return getRiskPreset(level);
}

function riskTop(level: "low" | "medium" | "high"): TopBadge {
  return { segs: [preset(level).pill], align: "right" };
}

function renderTop(
  width: number,
  stops: ReturnType<typeof preset>["stops"],
  top?: TopBadge,
  nerd = false,
) {
  const prepared = fitTop(top, width - 2, nerd);
  return topBorderSegments(width, stops, prepared);
}

describe("topBorderSegments with risk pill", () => {
  test("contains risk label for medium", () => {
    expect(plainText(renderTop(60, preset("medium").stops, riskTop("medium")))).toContain("medium");
  });

  test("contains risk label for high", () => {
    expect(plainText(renderTop(60, preset("high").stops, riskTop("high")))).toContain("high");
  });

  test("contains warning symbol", () => {
    expect(plainText(renderTop(60, preset("medium").stops, riskTop("medium")))).toContain("⚠");
  });

  test("starts with rounded corner ╭ and ends with ╮", () => {
    const text = plainText(renderTop(60, preset("medium").stops, riskTop("medium")));
    expect(text).toMatch(/^╭/);
    expect(text).toMatch(/╮$/);
  });

  test("visual width matches requested width", () => {
    expect(stringWidth(plainText(renderTop(60, preset("medium").stops, riskTop("medium"))))).toBe(
      60,
    );
  });

  test("renders badge as a styled segment", () => {
    const segs = renderTop(60, preset("medium").stops, riskTop("medium"), false);
    const badgeSeg = segs.find((segment) => segment.text.includes("medium"));
    expect(badgeSeg).toBeDefined();
    expect(badgeSeg?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(badgeSeg?.bold).toBe(true);
  });

  test("low risk badge uses ✔ glyph and 'low risk' label", () => {
    const text = plainText(renderTop(60, preset("low").stops, riskTop("low")));
    expect(text).toContain("✔");
    expect(text).toContain("low risk");
    expect(text).not.toContain("⚠");
  });

  test("renders border without a pill when none provided", () => {
    const text = plainText(renderTop(60, preset("medium").stops));
    expect(stringWidth(text)).toBe(60);
    expect(text).toMatch(/^╭/);
    expect(text).toMatch(/╮$/);
    expect(text).not.toContain("medium");
    expect(text).not.toContain("⚠");
  });

  test("plain mode pads pill body with single spaces and no edge glyphs", () => {
    const text = plainText(renderTop(60, preset("medium").stops, riskTop("medium"), false));
    expect(text).not.toContain("\uE0B6");
    expect(text).not.toContain("\uE0B4");
    expect(text).toContain(" ⚠ medium risk ");
  });

  test("nerd mode wraps pill in Powerline curve edges", () => {
    const text = plainText(renderTop(60, preset("medium").stops, riskTop("medium"), true));
    expect(text).toContain("\uE0B6 ⚠ medium risk \uE0B4");
  });
});

describe("fitTop + topBorderSegments alignment + fit", () => {
  const stops = preset("medium").stops;

  test("align left puts pill right after ╭", () => {
    const top: TopBadge = {
      segs: [{ label: "LEFT", fg: [255, 255, 255], bg: [30, 30, 30] }],
      align: "left",
    };
    expect(plainText(renderTop(60, stops, top))).toMatch(/^╭─ LEFT /);
  });

  test("align right puts pill right before ╮", () => {
    const top: TopBadge = {
      segs: [{ label: "RIGHT", fg: [255, 255, 255], bg: [30, 30, 30] }],
      align: "right",
    };
    expect(plainText(renderTop(60, stops, top))).toMatch(/ RIGHT ─╮$/);
  });

  test("visual width stays equal to requested width with pill", () => {
    const top: TopBadge = {
      segs: [{ label: "breadcrumbs", fg: [255, 255, 255], bg: [30, 30, 30] }],
      align: "left",
    };
    expect(stringWidth(plainText(renderTop(60, stops, top)))).toBe(60);
  });

  test("fitTop drops pill when neither full nor narrow fits budget", () => {
    const top: TopBadge = {
      segs: [
        { label: "X".repeat(100), labelNarrow: "Y".repeat(100), fg: [1, 1, 1], bg: [2, 2, 2] },
      ],
      align: "left",
    };
    expect(fitTop(top, 38, false)).toBeUndefined();
  });

  test("fitTop falls back to narrow labels when full won't fit", () => {
    const top: TopBadge = {
      segs: [
        { label: "Providers", labelNarrow: "P", fg: [1, 1, 1], bg: [2, 2, 2] },
        { label: "API Key", labelNarrow: "K", fg: [1, 1, 1], bg: [2, 2, 2] },
        { label: "Model", labelNarrow: "M", fg: [1, 1, 1], bg: [2, 2, 2] },
        { label: "Default", labelNarrow: "D", fg: [1, 1, 1], bg: [2, 2, 2] },
      ],
      align: "left",
    };
    const prepared = fitTop(top, 28, false);
    expect(prepared).toBeDefined();
    const text = plainText(prepared?.segments ?? []);
    expect(text).not.toContain("Providers");
    expect(text).toContain(" P ");
    expect(text).toContain(" K ");
  });

  test("fitTop returns undefined for empty segs", () => {
    expect(fitTop({ segs: [], align: "left" }, 60, false)).toBeUndefined();
  });

  test("topBorderSegments ignores undefined prepared", () => {
    const text = plainText(topBorderSegments(60, stops, undefined));
    expect(stringWidth(text)).toBe(60);
    expect(text).toMatch(/^╭/);
    expect(text).toMatch(/╮$/);
  });

  test("fitTop uses narrowSegs when segs (full) does not fit", () => {
    const top: TopBadge = {
      segs: [
        { label: "WIDE LABEL ONE", fg: [1, 1, 1], bg: [2, 2, 2] },
        { label: "WIDE LABEL TWO", fg: [1, 1, 1], bg: [2, 2, 2] },
      ],
      narrowSegs: [{ label: "N", fg: [1, 1, 1], bg: [2, 2, 2] }],
      align: "left",
    };
    const prepared = fitTop(top, 10, false);
    expect(prepared).toBeDefined();
    const text = plainText(prepared?.segments ?? []);
    expect(text).toContain(" N ");
    expect(text).not.toContain("WIDE");
  });

  test("fitTop prefers segs full over narrowSegs when both fit", () => {
    const top: TopBadge = {
      segs: [{ label: "WIDE", fg: [1, 1, 1], bg: [2, 2, 2] }],
      narrowSegs: [{ label: "N", fg: [1, 1, 1], bg: [2, 2, 2] }],
      align: "left",
    };
    const prepared = fitTop(top, 60, false);
    expect(plainText(prepared?.segments ?? [])).toContain(" WIDE ");
  });

  test("fitTop falls through narrowSegs full → narrowSegs narrow", () => {
    const top: TopBadge = {
      segs: [{ label: "X".repeat(50), fg: [1, 1, 1], bg: [2, 2, 2] }],
      narrowSegs: [
        { label: "API Key", labelNarrow: "K", fg: [1, 1, 1], bg: [2, 2, 2] },
        { label: "Model", labelNarrow: "M", fg: [1, 1, 1], bg: [2, 2, 2] },
      ],
      align: "left",
    };
    // Budget 8: narrowSegs full = " API Key " + " Model " = 16 — too big.
    // narrowSegs narrow = " K " + " M " = 6 — fits.
    const prepared = fitTop(top, 8, false);
    const text = plainText(prepared?.segments ?? []);
    expect(text).toContain(" K ");
    expect(text).toContain(" M ");
    expect(text).not.toContain("API Key");
  });
});

describe("bottomBorderSegments", () => {
  const stops = preset("medium").stops;

  test("starts with ╰ and ends with ╯", () => {
    const visual = plainText(bottomBorderSegments(60, stops));
    expect(visual).toMatch(/^╰/);
    expect(visual).toMatch(/╯$/);
  });

  test("visual width matches requested width", () => {
    expect(stringWidth(plainText(bottomBorderSegments(60, stops)))).toBe(60);
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
    const visual = plainText(bottomBorderSegments(60, stops, "⢎ Loading"));
    expect(visual).toMatch(/^╰─/);
    expect(visual).toMatch(/╯$/);
  });

  test("visual width matches requested width", () => {
    expect(stringWidth(plainText(bottomBorderSegments(60, stops, "⢎ Loading")))).toBe(60);
  });

  test("status text is rendered in white, dashes/corners stay dim", () => {
    const border = bottomBorderSegments(60, stops, "⢎ Loading");
    const statusSegment = border.find((s) => s.text.includes("Loading"));
    expect(statusSegment?.color).toBe("#d2d2e1");
    const left = border.find((s) => s.text === "╰");
    const right = border.find((s) => s.text === "╯");
    expect(left?.color).toBe("#3c3c64");
    expect(right?.color).toBe("#3c3c64");
  });

  test("width stays constant across different status lengths", () => {
    expect(stringWidth(plainText(bottomBorderSegments(60, stops, "⢎ Hi")))).toBe(60);
    expect(
      stringWidth(plainText(bottomBorderSegments(60, stops, "⢎ Reticulating splines..."))),
    ).toBe(60);
  });

  test("truncates status with ellipsis when it does not fit at full length", () => {
    const visual = plainText(bottomBorderSegments(20, stops, "⢎ Reticulating splines..."));
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
