import { describe, expect, test } from "bun:test";
import { buildAttachedInputPreview, readAttachedInput } from "../src/core/attached-input.ts";

const encoder = new TextEncoder();

describe("readAttachedInput", () => {
  test("returns undefined when stdin is a TTY", async () => {
    const result = await readAttachedInput({
      isTTY: true,
      read: () => Promise.resolve(encoder.encode("should not be read")),
    });
    expect(result).toBeUndefined();
  });

  test("returns bytes when stdin is piped", async () => {
    const bytes = encoder.encode("hello world");
    const result = await readAttachedInput({
      isTTY: undefined,
      read: () => Promise.resolve(bytes),
    });
    expect(result).toEqual(bytes);
  });

  test("returns undefined when piped content is zero bytes", async () => {
    const result = await readAttachedInput({
      isTTY: undefined,
      read: () => Promise.resolve(new Uint8Array(0)),
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined for UTF-8 whitespace-only content", async () => {
    const bytes = encoder.encode("   \n\t  \n  ");
    const result = await readAttachedInput({
      isTTY: undefined,
      read: () => Promise.resolve(bytes),
    });
    expect(result).toBeUndefined();
  });

  test("reads when isTTY is false (not just undefined)", async () => {
    const bytes = encoder.encode("content");
    const result = await readAttachedInput({
      isTTY: false,
      read: () => Promise.resolve(bytes),
    });
    expect(result).toEqual(bytes);
  });

  test("does not call read when stdin is a TTY", async () => {
    let called = false;
    await readAttachedInput({
      isTTY: true,
      read: () => {
        called = true;
        return Promise.resolve(encoder.encode("content"));
      },
    });
    expect(called).toBe(false);
  });

  test("preserves non-UTF-8 bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x42]);
    const result = await readAttachedInput({
      isTTY: undefined,
      read: () => Promise.resolve(bytes),
    });
    expect(result).toEqual(bytes);
  });
});

describe("buildAttachedInputPreview", () => {
  test("returns the full content and truncated=false when under budget", () => {
    const result = buildAttachedInputPreview(encoder.encode("hello world"), 200);
    expect(result.preview).toBe("hello world");
    expect(result.truncated).toBe(false);
  });

  test("truncates and flags truncated=true when over budget", () => {
    const long = "x".repeat(500);
    const result = buildAttachedInputPreview(encoder.encode(long), 100);
    expect(result.truncated).toBe(true);
    expect(result.preview.length).toBeLessThan(long.length);
  });

  test("reports binary content summary for invalid UTF-8", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0xc0, 0xc1]);
    const result = buildAttachedInputPreview(bytes, 200);
    expect(result.truncated).toBe(false);
    expect(result.preview).toContain("Binary content");
    expect(result.preview).toContain(String(bytes.byteLength));
  });

  test("preserves multi-byte UTF-8 characters", () => {
    const result = buildAttachedInputPreview(encoder.encode("héllo"), 200);
    expect(result.preview).toBe("héllo");
    expect(result.truncated).toBe(false);
  });

  test("empty input yields empty preview", () => {
    const result = buildAttachedInputPreview(new Uint8Array(0), 200);
    expect(result.preview).toBe("");
    expect(result.truncated).toBe(false);
  });
});
