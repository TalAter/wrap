import { describe, expect, test } from "bun:test";
import {
  ANSI16,
  bold,
  dim,
  fg,
  fgCode,
  gradient,
  gradientCells,
  interpolate,
  quantizeColor,
  stripAnsi,
} from "../src/core/ansi.ts";

const ESC = "\x1b[";

describe("bold", () => {
  test("wraps text in bold ANSI codes", () => {
    const result = bold("hello");
    expect(result).toBe(`${ESC}1mhello${ESC}0m`);
  });
});

describe("dim", () => {
  test("wraps text in dim ANSI codes", () => {
    const result = dim("hello");
    expect(result).toBe(`${ESC}2mhello${ESC}0m`);
  });
});

describe("fg", () => {
  test("applies truecolor foreground", () => {
    const result = fg("hi", 255, 0, 128);
    expect(result).toBe(`${ESC}38;2;255;0;128mhi${ESC}0m`);
  });
});

describe("stripAnsi", () => {
  test("removes all ANSI escape sequences", () => {
    const colored = `${ESC}1m${ESC}38;2;255;0;0mhello${ESC}0m world`;
    expect(stripAnsi(colored)).toBe("hello world");
  });

  test("returns plain text unchanged", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("fgCode", () => {
  test("level 3 emits 24-bit truecolor", () => {
    expect(fgCode(255, 0, 128, 3)).toBe(`${ESC}38;2;255;0;128m`);
  });

  test("level 2 emits 256-color indexed", () => {
    const code = fgCode(255, 0, 0, 2);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape
    expect(code).toMatch(/^\x1b\[38;5;\d+m$/);
  });

  test("level 1 emits basic 16-color SGR", () => {
    // Pure red → nearest bright red (91) or red (31)
    const code = fgCode(255, 0, 0, 1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape
    expect(code).toMatch(/^\x1b\[(3[0-7]|9[0-7])m$/);
  });

  test("level 0 emits empty string", () => {
    expect(fgCode(255, 0, 0, 0)).toBe("");
  });
});

describe("gradient", () => {
  const stops: [number, number, number][] = [
    [255, 0, 0],
    [0, 0, 255],
  ];

  test("returns string containing ANSI truecolor escapes", () => {
    const result = gradient("hello", stops);
    expect(result).toContain(`${ESC}38;2;`);
  });

  test("first and last visible chars have different colors", () => {
    const result = gradient("abcdefghij", stops);
    // First char should be near red (255,0,0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    expect(result).toMatch(/\x1b\[38;2;25[0-5];\d{1,2};\d{1,2}m/);
    // Last char should be near blue (0,0,255)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    expect(result).toMatch(/\x1b\[38;2;\d{1,2};\d{1,2};25[0-5]m/);
  });

  test("mid-point of red→green is not muddy brown (OKLAB/perceptual)", () => {
    const rg: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
    ];
    // Midpoint char at index 2 of length 5 (t = 0.5)
    const result = gradient("xxxxx", rg);
    const strip = stripAnsi(result);
    expect(strip).toBe("xxxxx");
    // Pull every 38;2;R;G;B from the output and check the mid-color
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    const matches = [...result.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    const mid = matches[2] as RegExpMatchArray;
    const [r, g, b] = [Number(mid[1]), Number(mid[2]), Number(mid[3])];
    // RGB midpoint would be (127,127,0) — dull olive/brown.
    // OKLAB midpoint is noticeably brighter and more saturated than the RGB average.
    expect(r + g).toBeGreaterThan(300);
    expect(b).toBeLessThan(40);
  });

  test("preserves spaces without color escapes", () => {
    const result = gradient("a b", stops);
    expect(stripAnsi(result)).toBe("a b");
  });

  test("handles single character", () => {
    const result = gradient("x", stops);
    expect(result).toContain(`${ESC}38;2;`);
    expect(stripAnsi(result)).toBe("x");
  });

  test("handles empty string", () => {
    const result = gradient("", stops);
    expect(result).toBe("");
  });

  test("shine brightens colors near the shine position", () => {
    const darkStops: [number, number, number][] = [
      [100, 0, 0],
      [0, 0, 100],
    ];
    const normal = gradient("abcdefghij", darkStops);
    const shiny = gradient("abcdefghij", darkStops, 5);
    expect(shiny).not.toBe(normal);
  });

  test("shine far offscreen produces same result as no shine", () => {
    const normal = gradient("abcde", stops);
    const shiny = gradient("abcde", stops, -20);
    expect(shiny).toBe(normal);
  });

  test("shine preserves text content", () => {
    const result = gradient("hello", stops, 2);
    expect(stripAnsi(result)).toBe("hello");
  });

  test("level 0 strips color entirely", () => {
    const result = gradient("hello", stops, undefined, undefined, 0);
    expect(result).toBe("hello");
  });

  test("level 1 emits only 16-color SGR codes", () => {
    const result = gradient("hello", stops, undefined, undefined, 1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    expect(result).not.toMatch(/\x1b\[38;2;/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    expect(result).not.toMatch(/\x1b\[38;5;/);
    expect(stripAnsi(result)).toBe("hello");
  });
});

describe("gradientCells", () => {
  const stops: [number, number, number][] = [
    [255, 0, 0],
    [0, 0, 255],
  ];

  test("returns one entry per character", () => {
    expect(gradientCells("hello", stops).length).toBe(5);
  });

  test("spaces are plain single-space entries", () => {
    const cells = gradientCells("a b", stops);
    expect(cells[1]).toBe(" ");
  });

  test("each non-space cell contains its character", () => {
    const cells = gradientCells("abc", stops);
    const chars = ["a", "b", "c"];
    for (let i = 0; i < 3; i++) {
      expect(stripAnsi(cells[i] as string)).toBe(chars[i] as string);
    }
  });

  test("level 0 returns plain characters with no escapes", () => {
    const cells = gradientCells("abc", stops, undefined, undefined, 0);
    expect(cells).toEqual(["a", "b", "c"]);
  });

  test("shine changes the cell under the beam", () => {
    const without = gradientCells("abcdefghij", stops);
    const withShine = gradientCells("abcdefghij", stops, 5);
    expect(withShine[5]).not.toBe(without[5]);
  });

  test("cells outside shine radius are unchanged", () => {
    const without = gradientCells("abcdefghij", stops);
    const withShine = gradientCells("abcdefghij", stops, 5, 2);
    // col 0 is far outside radius 2 around pos 5
    expect(withShine[0]).toBe(without[0]);
    expect(withShine[9]).toBe(without[9]);
  });
});

describe("quantizeColor", () => {
  test("all 16 ANSI16 entries round-trip through fgCode + quantizeColor at level 1", () => {
    const expectedCodes = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
    const rgbs = Object.values(ANSI16);
    expect(rgbs).toHaveLength(expectedCodes.length);
    for (let i = 0; i < rgbs.length; i++) {
      const rgb = rgbs[i] as [number, number, number];
      const code = expectedCodes[i] as number;
      expect(fgCode(rgb[0], rgb[1], rgb[2], 1)).toBe(`${ESC}${code}m`);
      expect(quantizeColor(rgb, 1)).toEqual(rgb);
    }
  });

  test("level 1 snaps pure red to ANSI16 red (not black)", () => {
    // Nearest in the xterm palette is [170,0,0] (code 31), not [0,0,0].
    expect(quantizeColor([255, 0, 0], 1)).toEqual([170, 0, 0]);
  });

  test("level 2 round-trips grayscale ramp boundary idx 232", () => {
    // to256(8,8,8) === 232; idx256ToRgb(232) must take the grayscale branch.
    expect(quantizeColor([8, 8, 8], 2)).toEqual([8, 8, 8]);
  });
});

describe("fgCode level 2 cube encoding", () => {
  test("non-grayscale color picks the exact 6×6×6 cube slot", () => {
    // ri=1 (95), gi=1 (95), bi=2 (135) → 16 + 36 + 6 + 2 = 60.
    expect(fgCode(100, 50, 150, 2)).toBe(`${ESC}38;5;60m`);
  });

  test("grayscale r=248 lands on the top of the 24-step ramp (255)", () => {
    // Boundary: r > 248 returns 231 (cube white); r === 248 stays on the ramp.
    expect(fgCode(248, 248, 248, 2)).toBe(`${ESC}38;5;255m`);
  });
});

describe("interpolate (OKLAB round-trip)", () => {
  const cases: [number, number, number][] = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [128, 128, 128],
  ];
  for (const c of cases) {
    test(`endpoint identity for ${c.join(",")}`, () => {
      const out = interpolate([c, [0, 0, 0]], 0);
      expect(out[0]).toBe(c[0]);
      expect(out[1]).toBe(c[1]);
      expect(out[2]).toBe(c[2]);
    });
  }

  test("grayscale interpolation stays neutral", () => {
    const mid = interpolate(
      [
        [40, 40, 40],
        [200, 200, 200],
      ],
      0.5,
    );
    expect(Math.abs(mid[0] - mid[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(mid[1] - mid[2])).toBeLessThanOrEqual(1);
  });
});
