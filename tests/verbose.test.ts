import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetVerboseTimer, verbose } from "../src/core/verbose.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";
import { seedTestConfig } from "./helpers.ts";

let stderr: MockStderr;

beforeEach(() => {
  resetVerboseTimer();
  seedTestConfig();
  stderr = mockStderr();
});

afterEach(() => {
  stderr.restore();
});

describe("verbose module", () => {
  test("verbose is a no-op when disabled", () => {
    verbose("should not appear");
    expect(stderr.text).toBe("");
  });

  test("verbose emits to stderr when enabled", () => {
    seedTestConfig({ verbose: true });
    verbose("Config loaded (anthropic)");
    expect(stderr.text).toContain("Config loaded (anthropic)");
  });

  test("verbose line starts with guillemet prefix", () => {
    seedTestConfig({ verbose: true });
    verbose("test message");
    // Dim ANSI wraps the line, but guillemet is the first visible char
    expect(stderr.text).toContain("»");
    // Guillemet comes right after the dim escape
    expect(stderr.text).toContain("\x1b[2m»");
  });

  test("verbose line includes elapsed time in brackets", () => {
    seedTestConfig({ verbose: true });
    verbose("test message");
    // Format: » [+0.00s] message
    expect(stderr.text).toMatch(/» \[\+\d+\.\d{2}s\]/);
  });

  test("verbose line includes the message text", () => {
    seedTestConfig({ verbose: true });
    verbose("Tools: 28/34 available");
    expect(stderr.text).toContain("Tools: 28/34 available");
  });

  test("verbose line ends with newline", () => {
    seedTestConfig({ verbose: true });
    verbose("test");
    expect(stderr.text).toMatch(/\n$/);
  });

  test("verbose line is wrapped in dim ANSI", () => {
    seedTestConfig({ verbose: true });
    verbose("dim text");
    // Dim = ESC[2m ... ESC[0m
    expect(stderr.text).toContain("\x1b[2m");
  });

  test("elapsed time increases between calls", async () => {
    seedTestConfig({ verbose: true });
    verbose("first");
    await new Promise((r) => setTimeout(r, 50));
    verbose("second");
    const lines = stderr.text.trim().split("\n");
    const parseElapsed = (line: string) => {
      const match = line.match(/\[\+(\d+\.\d+)s\]/);
      return match?.[1] ? Number.parseFloat(match[1]) : 0;
    };
    expect(parseElapsed(lines[1] ?? "")).toBeGreaterThan(parseElapsed(lines[0] ?? ""));
  });
});
