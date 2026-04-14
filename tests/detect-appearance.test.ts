import { describe, expect, test } from "bun:test";
import { parseOsc11Response } from "../src/core/detect-appearance.ts";

describe("parseOsc11Response", () => {
  test("parses dark background (Ghostty)", () => {
    expect(parseOsc11Response("\x1b]11;rgb:2828/2c2c/3434\x07")).toBe("dark");
  });

  test("parses light background (Terminal.app white)", () => {
    expect(parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("light");
  });

  test("parses medium-dark background as dark", () => {
    // luminance ~0.1 → dark
    expect(parseOsc11Response("\x1b]11;rgb:4040/4040/4040\x07")).toBe("dark");
  });

  test("parses medium-light background as light", () => {
    // luminance >0.5 → light
    expect(parseOsc11Response("\x1b]11;rgb:c0c0/c0c0/c0c0\x07")).toBe("light");
  });

  test("handles ST terminator (\\x1b\\\\)", () => {
    expect(parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toBe("light");
  });

  test("returns null for empty string", () => {
    expect(parseOsc11Response("")).toBeNull();
  });

  test("returns null for garbage", () => {
    expect(parseOsc11Response("not an osc response")).toBeNull();
  });

  test("returns null for malformed rgb", () => {
    expect(parseOsc11Response("\x1b]11;rgb:zzzz/zzzz/zzzz\x07")).toBeNull();
  });

  test("returns null for incomplete response", () => {
    expect(parseOsc11Response("\x1b]11;rgb:2828/2c2c")).toBeNull();
  });
});
