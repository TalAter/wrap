import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendWrapFile, getWrapHome, readWrapFile, writeWrapFile } from "../src/fs/home.ts";
import { tmpHome } from "./helpers.ts";

function withHome<T>(fn: (home: string) => T): T {
  const home = tmpHome();
  const prev = process.env.WRAP_HOME;
  process.env.WRAP_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.WRAP_HOME;
    else process.env.WRAP_HOME = prev;
  }
}

describe("getWrapHome", () => {
  test("returns WRAP_HOME when set", () => {
    expect(getWrapHome({ WRAP_HOME: "/custom/path" })).toBe("/custom/path");
  });

  test("falls back to ~/.wrap when WRAP_HOME is unset, undefined, or empty", () => {
    expect(getWrapHome({})).toBe(join(homedir(), ".wrap"));
    expect(getWrapHome({ WRAP_HOME: undefined })).toBe(join(homedir(), ".wrap"));
    expect(getWrapHome({ WRAP_HOME: "" })).toBe(join(homedir(), ".wrap"));
  });
});

describe("wrap-home IO", () => {
  test("readWrapFile returns null for missing file", () => {
    withHome(() => {
      expect(readWrapFile("nope.txt")).toBeNull();
    });
  });

  test("writeWrapFile + readWrapFile round-trip", () => {
    withHome((home) => {
      writeWrapFile("greeting.txt", "hello");
      expect(readWrapFile("greeting.txt")).toBe("hello");
      expect(readFileSync(join(home, "greeting.txt"), "utf-8")).toBe("hello");
    });
  });

  test("writeWrapFile creates nested parent directories", () => {
    withHome((home) => {
      writeWrapFile("cache/models.dev.json", '{"ok":1}');
      expect(existsSync(join(home, "cache"))).toBe(true);
      expect(readWrapFile("cache/models.dev.json")).toBe('{"ok":1}');
    });
  });

  test("writeWrapFile overwrites an existing file", () => {
    withHome(() => {
      writeWrapFile("greeting.txt", "first");
      writeWrapFile("greeting.txt", "second");
      expect(readWrapFile("greeting.txt")).toBe("second");
    });
  });

  test("appendWrapFile creates file then appends", () => {
    withHome(() => {
      appendWrapFile("logs/app.log", "line1\n");
      appendWrapFile("logs/app.log", "line2\n");
      expect(readWrapFile("logs/app.log")).toBe("line1\nline2\n");
    });
  });

  test("explicit home override ignores $WRAP_HOME", () => {
    const other = tmpHome();
    withHome(() => {
      writeWrapFile("cache/x.json", "{}", other);
      expect(readWrapFile("cache/x.json", other)).toBe("{}");
      expect(readWrapFile("cache/x.json")).toBeNull();
      expect(existsSync(join(other, "cache"))).toBe(true);
    });
  });
});
