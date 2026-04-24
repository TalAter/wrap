import { describe, expect, test } from "bun:test";
import {
  parseOsc11Response,
  queryTerminalBackground,
  resolveAppearance,
} from "../src/core/detect-appearance.ts";
import { mockStderr } from "./helpers/mock-stderr.ts";
import { mockStdin } from "./helpers/mock-stdin.ts";

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

describe("queryTerminalBackground", () => {
  // Regression: OSC 11 detection used to grab process.stdin raw mode, then
  // release it with setRawMode(false) + pause() on cleanup. If the wizard's
  // Ink render happened between grab and release, Ink inherited a paused,
  // cooked stdin — keys echoed raw and ⏎/Esc/arrows did nothing. Detection
  // must read from /dev/tty instead and never touch process.stdin.
  test("does not touch process.stdin raw mode", async () => {
    const stderr = mockStderr({ isTTY: true });
    const stdin = mockStdin({ isTTY: true, spySetRawMode: true });
    try {
      await queryTerminalBackground(10);
    } finally {
      stdin.restore();
      stderr.restore();
    }
    expect(stdin.setRawModeCalled).toBe(false);
  });
});

describe("resolveAppearance", () => {
  // Regression: probe used to be fire-and-forget. On cache-miss it raced
  // with Ink dialog mount — probe's setRawMode(false) cleanup fired after
  // Ink claimed stdin, leaving the terminal cooked while Ink thought raw.
  // Keys echoed to the shell instead of the dialog. Fix: await the probe
  // so no raw-mode toggling overlaps with any dialog lifecycle.
  test("awaits probe on cache-miss", async () => {
    const prevHome = process.env.WRAP_HOME;
    const prevTheme = process.env.WRAP_THEME;
    process.env.WRAP_HOME = `/tmp/wrap-test-${Date.now()}-${Math.random()}`;
    delete process.env.WRAP_THEME;
    const stderr = mockStderr({ isTTY: false }); // isTTY:false → probe returns null fast
    try {
      const result = resolveAppearance(undefined);
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe("dark");
    } finally {
      stderr.restore();
      if (prevHome === undefined) delete process.env.WRAP_HOME;
      else process.env.WRAP_HOME = prevHome;
      if (prevTheme !== undefined) process.env.WRAP_THEME = prevTheme;
    }
  });
});
