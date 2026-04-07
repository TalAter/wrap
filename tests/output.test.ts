import { afterEach, describe, expect, test } from "bun:test";
import { chrome, chromeRaw } from "../src/core/output.ts";

const originalStderrWrite = process.stderr.write;
let captured = "";

function captureStderr() {
  captured = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  };
}

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

describe("chrome", () => {
  test("writes message with trailing newline to stderr", () => {
    captureStderr();
    chrome("hello");
    expect(captured).toBe("hello\n");
  });

  test("does not double-newline", () => {
    captureStderr();
    chrome("line");
    expect(captured).toBe("line\n");
  });

  test("two-arg form prefixes the icon", () => {
    captureStderr();
    chrome("Probing the database", "🔍");
    expect(captured).toBe("🔍 Probing the database\n");
  });

  test("omitting icon yields no leading space", () => {
    captureStderr();
    chrome("plain");
    expect(captured).toBe("plain\n");
    expect(captured.startsWith(" ")).toBe(false);
  });
});

describe("chromeRaw", () => {
  test("writes message without trailing newline to stderr", () => {
    captureStderr();
    chromeRaw("raw");
    expect(captured).toBe("raw");
  });

  test("passes ANSI escapes through unchanged", () => {
    captureStderr();
    chromeRaw("\x1b[?25l");
    expect(captured).toBe("\x1b[?25l");
  });
});
