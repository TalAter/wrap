import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chrome, chromeRaw, colorLevel, shouldAnimate } from "../src/core/output.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

let stderr: MockStderr;

beforeEach(() => {
  stderr = mockStderr();
});

afterEach(() => {
  stderr.restore();
});

describe("chrome", () => {
  test("writes message with trailing newline to stderr", () => {
    chrome("hello");
    expect(stderr.text).toBe("hello\n");
  });

  test("does not double-newline", () => {
    chrome("line");
    expect(stderr.text).toBe("line\n");
  });

  test("two-arg form prefixes the icon", () => {
    chrome("Probing the database", "🔍");
    expect(stderr.text).toBe("🔍 Probing the database\n");
  });

  test("omitting icon yields no leading space", () => {
    chrome("plain");
    expect(stderr.text).toBe("plain\n");
    expect(stderr.text.startsWith(" ")).toBe(false);
  });
});

describe("chromeRaw", () => {
  test("writes message without trailing newline to stderr", () => {
    chromeRaw("raw");
    expect(stderr.text).toBe("raw");
  });

  test("passes ANSI escapes through unchanged", () => {
    chromeRaw("\x1b[?25l");
    expect(stderr.text).toBe("\x1b[?25l");
  });
});

describe("shouldAnimate", () => {
  const envKeys = ["NO_COLOR", "CI", "TERM", "WRAP_NO_MOTION"];
  let saved: Record<string, string | undefined>;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
    origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.TERM = "xterm-256color";
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
  });

  test("true when interactive TTY with defaults", () => {
    expect(shouldAnimate()).toBe(true);
  });

  test("false when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(shouldAnimate()).toBe(false);
  });

  test("false when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(shouldAnimate()).toBe(false);
  });

  test("false when CI is set", () => {
    process.env.CI = "true";
    expect(shouldAnimate()).toBe(false);
  });

  test("false when TERM=dumb", () => {
    process.env.TERM = "dumb";
    expect(shouldAnimate()).toBe(false);
  });

  test("false when WRAP_NO_MOTION is set", () => {
    process.env.WRAP_NO_MOTION = "1";
    expect(shouldAnimate()).toBe(false);
  });

  test("false when NO_COLOR is the empty string", () => {
    process.env.NO_COLOR = "";
    expect(shouldAnimate()).toBe(false);
  });

  test("false when enabled=false", () => {
    expect(shouldAnimate({ enabled: false })).toBe(false);
  });
});

describe("colorLevel", () => {
  const envKeys = ["NO_COLOR", "COLORTERM", "TERM"];
  let saved: Record<string, string | undefined>;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
    origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
  });

  test("0 (mono) when NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    expect(colorLevel()).toBe(0);
  });

  test("0 when not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(colorLevel()).toBe(0);
  });

  test("3 (truecolor) when COLORTERM=truecolor", () => {
    process.env.COLORTERM = "truecolor";
    process.env.TERM = "xterm-256color";
    expect(colorLevel()).toBe(3);
  });

  test("3 when COLORTERM=24bit", () => {
    process.env.COLORTERM = "24bit";
    expect(colorLevel()).toBe(3);
  });

  test("2 (256) when TERM contains -256color", () => {
    process.env.TERM = "xterm-256color";
    expect(colorLevel()).toBe(2);
  });

  test("1 (16) when TERM=xterm with no extras", () => {
    process.env.TERM = "xterm";
    expect(colorLevel()).toBe(1);
  });

  test("0 when TERM=dumb", () => {
    process.env.TERM = "dumb";
    expect(colorLevel()).toBe(0);
  });
});
