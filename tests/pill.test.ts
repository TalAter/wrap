import { beforeAll, describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { type PillSegment, pillSegments, pillWidth } from "../src/tui/pill.tsx";
import { seedTestConfig } from "./helpers.ts";

beforeAll(() => {
  seedTestConfig();
});

function plainText(segs: { text: string }[]): string {
  return segs.map((s) => s.text).join("");
}

const WIZ: PillSegment = {
  label: "Wizard",
  labelNarrow: "W",
  fg: [200, 200, 240],
  bg: [70, 90, 150],
  bold: true,
};
const DONE: PillSegment = {
  label: "API Key",
  labelNarrow: "K",
  fg: [140, 220, 170],
  bg: [40, 90, 60],
};
const ACTIVE: PillSegment = {
  label: "Model",
  labelNarrow: "M",
  fg: [180, 200, 255],
  bg: [60, 80, 160],
};

describe("pillWidth", () => {
  test("single plain pill = label + 2 padding", () => {
    expect(pillWidth([WIZ], false, false)).toBe(stringWidth(" Wizard ")); // 8
  });

  test("single nerd pill = plain + 2 curves", () => {
    expect(pillWidth([WIZ], true, false)).toBe(stringWidth(" Wizard ") + 2);
  });

  test("multiple plain pills sum bodies, no separators", () => {
    const expected = stringWidth(" Wizard ") + stringWidth(" API Key ") + stringWidth(" Model ");
    expect(pillWidth([WIZ, DONE, ACTIVE], false, false)).toBe(expected);
  });

  test("multiple nerd pills add L-curve + R-curve + (N-1) flames", () => {
    const bodies = stringWidth(" Wizard ") + stringWidth(" API Key ") + stringWidth(" Model ");
    expect(pillWidth([WIZ, DONE, ACTIVE], true, false)).toBe(bodies + 2 + 2); // 2 curves + 2 flames
  });

  test("narrow uses labelNarrow when provided", () => {
    expect(pillWidth([WIZ, DONE, ACTIVE], false, true)).toBe(
      stringWidth(" W ") + stringWidth(" K ") + stringWidth(" M "),
    );
  });

  test("narrow falls back to label when labelNarrow missing", () => {
    const noNarrow: PillSegment = { label: "Risk", fg: [1, 1, 1], bg: [2, 2, 2] };
    expect(pillWidth([noNarrow], false, true)).toBe(stringWidth(" Risk "));
  });
});

describe("pillSegments", () => {
  test("plain single pill renders only padded body", () => {
    const segs = pillSegments([WIZ], false, false);
    expect(plainText(segs)).toBe(" Wizard ");
    expect(segs[0]?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(segs[0]?.bold).toBe(true);
  });

  test("plain multi-pill has no powerline glyphs", () => {
    const text = plainText(pillSegments([WIZ, DONE, ACTIVE], false, false));
    expect(text).not.toContain("\uE0B6");
    expect(text).not.toContain("\uE0B4");
    expect(text).not.toContain("\uE0C0");
    expect(text).toContain("Wizard");
    expect(text).toContain("API Key");
    expect(text).toContain("Model");
  });

  test("nerd single pill wraps body in L and R curves", () => {
    const text = plainText(pillSegments([WIZ], true, false));
    expect(text).toBe("\uE0B6 Wizard \uE0B4");
  });

  test("nerd multi pill uses flame between segments, curves on outside", () => {
    const segs = pillSegments([WIZ, DONE, ACTIVE], true, false);
    const text = plainText(segs);
    expect(text.startsWith("\uE0B6")).toBe(true);
    expect(text.endsWith("\uE0B4")).toBe(true);
    expect(text).toContain("\uE0C0");
    // 2 flames, not 3 (not before first, not after last)
    const flameCount = (text.match(/\uE0C0/g) ?? []).length;
    expect(flameCount).toBe(2);
  });

  test("nerd flames blend prev bg → next bg", () => {
    const segs = pillSegments([WIZ, DONE], true, false);
    const flame = segs.find((s) => s.text === "\uE0C0");
    expect(flame).toBeDefined();
    expect(flame?.color).toBe("#465a96"); // WIZ.bg quantized
    expect(flame?.backgroundColor).toBe("#285a3c"); // DONE.bg quantized
  });

  test("narrow mode swaps to labelNarrow", () => {
    const text = plainText(pillSegments([WIZ, DONE, ACTIVE], false, true));
    expect(text).toContain(" W ");
    expect(text).toContain(" K ");
    expect(text).toContain(" M ");
    expect(text).not.toContain("Wizard");
    expect(text).not.toContain("API Key");
  });

  test("pillSegments width equals pillWidth", () => {
    for (const narrow of [false, true]) {
      for (const nerd of [false, true]) {
        const w = stringWidth(plainText(pillSegments([WIZ, DONE, ACTIVE], nerd, narrow)));
        expect(w).toBe(pillWidth([WIZ, DONE, ACTIVE], nerd, narrow));
      }
    }
  });

  test("each body segment has bg + fg colors", () => {
    const segs = pillSegments([WIZ, DONE], true, false);
    const bodies = segs.filter((s) => s.text.includes("Wizard") || s.text.includes("API Key"));
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(b.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("bold prop threads onto body segment", () => {
    const segs = pillSegments([WIZ, DONE], false, false);
    const wizBody = segs.find((s) => s.text.includes("Wizard"));
    const doneBody = segs.find((s) => s.text.includes("API Key"));
    expect(wizBody?.bold).toBe(true);
    expect(doneBody?.bold).toBeFalsy();
  });

  test("empty segments array returns empty", () => {
    expect(pillSegments([], true, false)).toEqual([]);
    expect(pillSegments([], false, false)).toEqual([]);
    expect(pillWidth([], true, false)).toBe(0);
    expect(pillWidth([], false, false)).toBe(0);
  });
});
