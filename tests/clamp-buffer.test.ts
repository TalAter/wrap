import { describe, expect, test } from "bun:test";
import { clampBufferSize, MAX_BUFFER_BYTES } from "../src/tui/clamp-buffer.ts";

describe("clampBufferSize", () => {
  test("below cap: passes through untruncated", () => {
    const r = clampBufferSize("hello");
    expect(r.value).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  test("empty string: passes through", () => {
    const r = clampBufferSize("");
    expect(r.value).toBe("");
    expect(r.truncated).toBe(false);
  });

  test("exactly at cap in bytes: passes through", () => {
    const s = "a".repeat(MAX_BUFFER_BYTES);
    const r = clampBufferSize(s);
    expect(r.truncated).toBe(false);
    expect(r.value.length).toBe(MAX_BUFFER_BYTES);
  });

  test("above cap (ASCII): truncates and flags", () => {
    const s = "a".repeat(MAX_BUFFER_BYTES + 100);
    const r = clampBufferSize(s);
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.value).byteLength).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
  });

  test("truncation respects UTF-8 code-point boundary (no mojibake)", () => {
    // Build a string whose byte count lands mid-code-point when cut at the cap.
    // Use 4-byte emoji so the cap falls inside one.
    const filler = "a".repeat(MAX_BUFFER_BYTES - 2);
    const s = `${filler}😀😀😀`;
    const r = clampBufferSize(s);
    expect(r.truncated).toBe(true);
    // Must decode cleanly (no replacement chars).
    expect(r.value).not.toContain("�");
    // Every emoji present must be complete.
    expect(new TextEncoder().encode(r.value).byteLength).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
  });

  test("multibyte string below cap: unchanged", () => {
    const s = "héllo 👋 wörld";
    const r = clampBufferSize(s);
    expect(r.value).toBe(s);
    expect(r.truncated).toBe(false);
  });
});
