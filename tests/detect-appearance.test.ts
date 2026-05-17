import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheAppearance,
  getCachedAppearance,
  parseOsc11Response,
  queryTerminalBackground,
  resolveAppearance,
} from "../src/core/detect-appearance.ts";
import { mockStderr } from "./helpers/mock-stderr.ts";
import { mockStdin } from "./helpers/mock-stdin.ts";
import { isolateEnv, tmpHome } from "./helpers.ts";

function writeCache(home: string, contents: string): void {
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(join(home, "cache/appearance.json"), contents);
}

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

describe("getCachedAppearance / cacheAppearance round-trip", () => {
  // The cache spares wrap from a 50ms OSC 11 probe (and the raw-mode
  // dance that comes with it) on every invocation. If write or read
  // silently breaks, every `w` re-probes — a real perf + UX regression.
  test("returns dark appearance written by cacheAppearance", () => {
    const home = tmpHome();
    cacheAppearance("dark", home);
    expect(getCachedAppearance(home)).toBe("dark");
  });

  test("returns light appearance written by cacheAppearance", () => {
    const home = tmpHome();
    cacheAppearance("light", home);
    expect(getCachedAppearance(home)).toBe("light");
  });

  test("returns null when no cache file exists", () => {
    expect(getCachedAppearance(tmpHome())).toBeNull();
  });

  test("returns null for malformed cache JSON", () => {
    const home = tmpHome();
    writeCache(home, "not valid json{");
    expect(getCachedAppearance(home)).toBeNull();
  });

  test("returns null for unrecognized appearance value", () => {
    const home = tmpHome();
    writeCache(home, JSON.stringify({ appearance: "midnight", ts: Date.now() }));
    expect(getCachedAppearance(home)).toBeNull();
  });

  test("returns null when ts is the wrong type", () => {
    const home = tmpHome();
    writeCache(home, JSON.stringify({ appearance: "dark", ts: "yesterday" }));
    expect(getCachedAppearance(home)).toBeNull();
  });

  test("returns null for cache older than the 1h TTL", () => {
    const home = tmpHome();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    writeCache(home, JSON.stringify({ appearance: "dark", ts: twoHoursAgo }));
    expect(getCachedAppearance(home)).toBeNull();
  });

  test("returns cached value when 30 minutes old (within TTL)", () => {
    const home = tmpHome();
    const halfHourAgo = Date.now() - 30 * 60 * 1000;
    writeCache(home, JSON.stringify({ appearance: "dark", ts: halfHourAgo }));
    expect(getCachedAppearance(home)).toBe("dark");
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

describe("resolveAppearance precedence", () => {
  // Precedence chain: WRAP_THEME env > explicit config > disk cache >
  // probe > default-dark. Each test pins one tier dominating a competing
  // value at the next tier down. (Probe vs default isn't covered here
  // — see "awaits probe on cache-miss" above.)
  isolateEnv(["WRAP_HOME", "WRAP_THEME"]);

  test("WRAP_THEME=dark wins over conflicting config", async () => {
    process.env.WRAP_HOME = tmpHome();
    process.env.WRAP_THEME = "dark";
    expect(await resolveAppearance("light")).toBe("dark");
  });

  test("WRAP_THEME=light wins over conflicting config", async () => {
    process.env.WRAP_HOME = tmpHome();
    process.env.WRAP_THEME = "light";
    expect(await resolveAppearance("dark")).toBe("light");
  });

  test("config 'dark' wins over conflicting cache", async () => {
    const home = tmpHome();
    cacheAppearance("light", home);
    process.env.WRAP_HOME = home;
    expect(await resolveAppearance("dark")).toBe("dark");
  });

  test("config 'light' wins over conflicting cache", async () => {
    const home = tmpHome();
    cacheAppearance("dark", home);
    process.env.WRAP_HOME = home;
    expect(await resolveAppearance("light")).toBe("light");
  });

  test("cache hit returns cached value when env + config are absent/auto", async () => {
    const home = tmpHome();
    cacheAppearance("light", home);
    process.env.WRAP_HOME = home;
    expect(await resolveAppearance("auto")).toBe("light");
  });
});
