import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheAppearance,
  getCachedAppearance,
  parseOsc11Response,
  queryTerminalBackground,
  resolveAppearance,
} from "wrap-core/theme";
import { wrapFs } from "../src/fs/home.ts";
import { mockStderr } from "./helpers/mock-stderr.ts";
import { mockStdin } from "./helpers/mock-stdin.ts";
import { isolateEnv } from "./helpers.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const CACHE_DIR = join(TEST_HOME, "cache");
const CACHE_PATH = join(CACHE_DIR, "appearance.json");

function writeCache(contents: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, contents);
}

function clearCache(): void {
  rmSync(CACHE_DIR, { recursive: true, force: true });
}

describe("parseOsc11Response", () => {
  test("parses dark background (Ghostty)", () => {
    expect(parseOsc11Response("\x1b]11;rgb:2828/2c2c/3434\x07")).toBe("dark");
  });

  test("parses light background (Terminal.app white)", () => {
    expect(parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("light");
  });

  test("parses medium-dark background as dark", () => {
    expect(parseOsc11Response("\x1b]11;rgb:4040/4040/4040\x07")).toBe("dark");
  });

  test("parses medium-light background as light", () => {
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
  beforeEach(clearCache);

  test("returns dark appearance written by cacheAppearance", () => {
    cacheAppearance(wrapFs, "dark");
    expect(getCachedAppearance(wrapFs)).toBe("dark");
  });

  test("returns light appearance written by cacheAppearance", () => {
    cacheAppearance(wrapFs, "light");
    expect(getCachedAppearance(wrapFs)).toBe("light");
  });

  test("returns null when no cache file exists", () => {
    expect(getCachedAppearance(wrapFs)).toBeNull();
  });

  test("returns null for malformed cache JSON", () => {
    writeCache("not valid json{");
    expect(getCachedAppearance(wrapFs)).toBeNull();
  });

  test("returns null for unrecognized appearance value", () => {
    writeCache(JSON.stringify({ appearance: "midnight", ts: Date.now() }));
    expect(getCachedAppearance(wrapFs)).toBeNull();
  });

  test("returns null when ts is the wrong type", () => {
    writeCache(JSON.stringify({ appearance: "dark", ts: "yesterday" }));
    expect(getCachedAppearance(wrapFs)).toBeNull();
  });

  test("returns null for cache older than the 1h TTL", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    writeCache(JSON.stringify({ appearance: "dark", ts: twoHoursAgo }));
    expect(getCachedAppearance(wrapFs)).toBeNull();
  });

  test("returns cached value when 30 minutes old (within TTL)", () => {
    const halfHourAgo = Date.now() - 30 * 60 * 1000;
    writeCache(JSON.stringify({ appearance: "dark", ts: halfHourAgo }));
    expect(getCachedAppearance(wrapFs)).toBe("dark");
  });
});

describe("resolveAppearance", () => {
  test("awaits probe on cache-miss", async () => {
    clearCache();
    const prevTheme = process.env.WRAP_THEME;
    delete process.env.WRAP_THEME;
    const stderr = mockStderr({ isTTY: false });
    try {
      const result = resolveAppearance({ envVarName: "WRAP_THEME" });
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe("dark");
    } finally {
      stderr.restore();
      if (prevTheme !== undefined) process.env.WRAP_THEME = prevTheme;
    }
  });
});

describe("resolveAppearance precedence", () => {
  isolateEnv(["WRAP_THEME"]);
  beforeEach(clearCache);

  test("WRAP_THEME=dark wins over conflicting config", async () => {
    process.env.WRAP_THEME = "dark";
    expect(await resolveAppearance({ envVarName: "WRAP_THEME", configAppearance: "light" })).toBe(
      "dark",
    );
  });

  test("WRAP_THEME=light wins over conflicting config", async () => {
    process.env.WRAP_THEME = "light";
    expect(await resolveAppearance({ envVarName: "WRAP_THEME", configAppearance: "dark" })).toBe(
      "light",
    );
  });

  test("config 'dark' wins over conflicting cache", async () => {
    cacheAppearance(wrapFs, "light");
    expect(
      await resolveAppearance({ envVarName: "WRAP_THEME", configAppearance: "dark", fs: wrapFs }),
    ).toBe("dark");
  });

  test("config 'light' wins over conflicting cache", async () => {
    cacheAppearance(wrapFs, "dark");
    expect(
      await resolveAppearance({ envVarName: "WRAP_THEME", configAppearance: "light", fs: wrapFs }),
    ).toBe("light");
  });

  test("cache hit returns cached value when env + config are absent/auto", async () => {
    cacheAppearance(wrapFs, "light");
    expect(
      await resolveAppearance({ envVarName: "WRAP_THEME", configAppearance: "auto", fs: wrapFs }),
    ).toBe("light");
  });
});
