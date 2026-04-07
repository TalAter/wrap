import { afterEach, describe, expect, test } from "bun:test";
import { chrome, chromeRaw } from "../src/core/output.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

let stderr: MockStderr | null = null;
function captureStderr() {
  stderr = mockStderr();
}

afterEach(() => {
  stderr?.restore();
  stderr = null;
});

describe("chrome", () => {
  test("writes message with trailing newline to stderr", () => {
    captureStderr();
    chrome("hello");
    expect(stderr!.text).toBe("hello\n");
  });

  test("does not double-newline", () => {
    captureStderr();
    chrome("line");
    expect(stderr!.text).toBe("line\n");
  });

  test("two-arg form prefixes the icon", () => {
    captureStderr();
    chrome("Probing the database", "🔍");
    expect(stderr!.text).toBe("🔍 Probing the database\n");
  });

  test("omitting icon yields no leading space", () => {
    captureStderr();
    chrome("plain");
    expect(stderr!.text).toBe("plain\n");
    expect(stderr!.text.startsWith(" ")).toBe(false);
  });
});

describe("chromeRaw", () => {
  test("writes message without trailing newline to stderr", () => {
    captureStderr();
    chromeRaw("raw");
    expect(stderr!.text).toBe("raw");
  });

  test("passes ANSI escapes through unchanged", () => {
    captureStderr();
    chromeRaw("\x1b[?25l");
    expect(stderr!.text).toBe("\x1b[?25l");
  });
});
