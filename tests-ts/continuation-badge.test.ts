import { describe, expect, test } from "bun:test";
import { formatContinuationBadge } from "wrap-core/tui";

describe("formatContinuationBadge", () => {
  test("returns the prefixed text untouched when it fits", () => {
    expect(formatContinuationBadge("how do I deploy", 80)).toBe("↳ Continuing: how do I deploy");
  });

  test("collapses internal newlines to single spaces", () => {
    expect(formatContinuationBadge("line one\nline two\nline three", 80)).toBe(
      "↳ Continuing: line one line two line three",
    );
  });

  test("collapses runs of newlines and whitespace to a single space", () => {
    expect(formatContinuationBadge("a\n\n\n   b", 80)).toBe("↳ Continuing: a b");
  });

  test("truncates with a single-char ellipsis when the prompt is too long for the terminal", () => {
    // "↳ Continuing: " is 14 chars; total budget = 40 - 14 - 1 (gutter) = 25.
    // The prompt body trims to 24 chars + "…".
    const out = formatContinuationBadge("a".repeat(100), 40);
    expect(out).toStartWith("↳ Continuing: ");
    expect(out).toEndWith("…");
    expect(out.length).toBe(40 - 1);
  });

  test("respects the 20-char minimum body width even when terminal is narrow", () => {
    // columns=20 → budget = max(20, 20-14-1) = max(20, 5) = 20.
    const out = formatContinuationBadge("a".repeat(50), 20);
    expect(out).toStartWith("↳ Continuing: ");
    expect(out).toEndWith("…");
    // 14 prefix + 19 body + 1 ellipsis = 34 chars total
    expect(out.length).toBe(34);
  });

  test("omits the badge entirely when terminal is narrower than 20 cols", () => {
    expect(formatContinuationBadge("anything", 19)).toBe("");
    expect(formatContinuationBadge("anything", 0)).toBe("");
  });

  test("does not append an ellipsis when body length equals budget exactly", () => {
    // columns=40 → budget = max(20, 40 - 14 - 1) = 25. Body matches budget exactly.
    const body = "x".repeat(25);
    const out = formatContinuationBadge(body, 40);
    expect(out).toBe(`↳ Continuing: ${body}`);
    expect(out).not.toEndWith("…");
  });

  test("returns an empty string when prompt is empty (no badge for nothing)", () => {
    expect(formatContinuationBadge("", 80)).toBe("");
    expect(formatContinuationBadge("   \n\n  ", 80)).toBe("");
  });
});
