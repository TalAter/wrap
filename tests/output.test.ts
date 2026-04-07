import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chrome, chromeRaw } from "../src/core/output.ts";
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
