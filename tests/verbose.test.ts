import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initVerbose, resetVerbose, verbose } from "../src/core/verbose.ts";

const originalStderrWrite = process.stderr.write;
let captured = "";

function captureStderr() {
  captured = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  };
}

beforeEach(() => {
  resetVerbose();
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

describe("verbose module", () => {
  test("verbose is a no-op when not initialized", () => {
    captureStderr();
    verbose("should not appear");
    expect(captured).toBe("");
  });

  test("verbose is a no-op when initialized with enabled=false", () => {
    initVerbose(false);
    captureStderr();
    verbose("should not appear");
    expect(captured).toBe("");
  });

  test("verbose emits to stderr when enabled", () => {
    initVerbose(true);
    captureStderr();
    verbose("Config loaded (anthropic)");
    expect(captured).toContain("Config loaded (anthropic)");
  });

  test("verbose line starts with guillemet prefix", () => {
    initVerbose(true);
    captureStderr();
    verbose("test message");
    // Dim ANSI wraps the line, but guillemet is the first visible char
    expect(captured).toContain("»");
    // Guillemet comes right after the dim escape
    expect(captured).toContain("\x1b[2m»");
  });

  test("verbose line includes elapsed time in brackets", () => {
    initVerbose(true);
    captureStderr();
    verbose("test message");
    // Format: » [+0.00s] message
    expect(captured).toMatch(/» \[\+\d+\.\d{2}s\]/);
  });

  test("verbose line includes the message text", () => {
    initVerbose(true);
    captureStderr();
    verbose("Tools: 28/34 available");
    expect(captured).toContain("Tools: 28/34 available");
  });

  test("verbose line ends with newline", () => {
    initVerbose(true);
    captureStderr();
    verbose("test");
    expect(captured).toMatch(/\n$/);
  });

  test("verbose line is wrapped in dim ANSI", () => {
    initVerbose(true);
    captureStderr();
    verbose("dim text");
    // Dim = ESC[2m ... ESC[0m
    expect(captured).toContain("\x1b[2m");
  });

  test("initVerbose can only be called once", () => {
    initVerbose(true);
    expect(() => initVerbose(false)).toThrow();
  });

  test("elapsed time increases between calls", async () => {
    initVerbose(true);
    captureStderr();
    verbose("first");
    await new Promise((r) => setTimeout(r, 50));
    verbose("second");
    const lines = captured.trim().split("\n");
    const parseElapsed = (line: string) => {
      const match = line.match(/\[\+(\d+\.\d+)s\]/);
      return match?.[1] ? Number.parseFloat(match[1]) : 0;
    };
    expect(parseElapsed(lines[1] ?? "")).toBeGreaterThan(parseElapsed(lines[0] ?? ""));
  });
});
