import { describe, expect, test } from "bun:test";
import { truncateMiddle } from "../src/core/truncate.ts";

describe("truncateMiddle", () => {
  test("returns input unchanged when within limit", () => {
    expect(truncateMiddle("short", 100)).toBe("short");
  });

  test("returns input unchanged when exactly at limit", () => {
    const text = "a".repeat(100);
    expect(truncateMiddle(text, 100)).toBe(text);
  });

  test("truncates middle of long string, keeps head and tail", () => {
    // 26 chars: abcdefghijklmnopqrstuvwxyz
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = truncateMiddle(text, 20);
    // Should start with head chars and end with tail chars
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("z")).toBe(true);
    expect(result).toContain("…truncated");
    expect(result).toContain("of 26 chars");
  });

  test("head and tail together fit roughly within limit", () => {
    const text = "x".repeat(1000);
    const result = truncateMiddle(text, 200);
    // maxChars is approximate — output may exceed by up to ~80 chars (indicator line)
    expect(result.length).toBeLessThan(200 + 100);
    expect(result).toContain("…truncated");
  });

  test("preserves line boundaries — splits at newlines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = truncateMiddle(text, 200);
    // Head should end at a newline boundary (complete lines)
    expect(result).toContain("line 1\n");
    // Tail should contain the last line
    expect(result).toContain("line 100");
    expect(result).toContain("…truncated");
  });

  test("indicator shows correct char counts", () => {
    const text = "a".repeat(500);
    const result = truncateMiddle(text, 100);
    expect(result).toContain("of 500 chars");
    // Should mention "showing first X and last Y"
    expect(result).toMatch(/showing first \d+ and last \d+/);
  });

  test("handles single-line input over limit", () => {
    const text = "a".repeat(300);
    const result = truncateMiddle(text, 100);
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("a")).toBe(true);
    expect(result).toContain("…truncated");
  });

  test("handles maxChars of 0 gracefully", () => {
    const result = truncateMiddle("hello", 0);
    // Should still return something reasonable
    expect(result).toContain("…truncated");
  });
});
