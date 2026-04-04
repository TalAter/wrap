import { describe, expect, test } from "bun:test";
import { readPipedInput } from "../src/core/piped-input.ts";

describe("readPipedInput", () => {
  test("returns null when stdin is a TTY", async () => {
    const result = await readPipedInput({
      isTTY: true,
      read: () => Promise.resolve("should not be read"),
    });
    expect(result).toBeNull();
  });

  test("returns content when stdin is piped", async () => {
    const result = await readPipedInput({
      isTTY: undefined,
      read: () => Promise.resolve("hello world"),
    });
    expect(result).toBe("hello world");
  });

  test("returns null when piped content is empty", async () => {
    const result = await readPipedInput({
      isTTY: undefined,
      read: () => Promise.resolve(""),
    });
    expect(result).toBeNull();
  });

  test("returns null when piped content is whitespace-only", async () => {
    const result = await readPipedInput({
      isTTY: undefined,
      read: () => Promise.resolve("   \n\t  \n  "),
    });
    expect(result).toBeNull();
  });

  test("reads when isTTY is false (not just undefined)", async () => {
    const result = await readPipedInput({
      isTTY: false,
      read: () => Promise.resolve("content"),
    });
    expect(result).toBe("content");
  });

  test("preserves leading/trailing whitespace in non-empty content", async () => {
    const result = await readPipedInput({
      isTTY: undefined,
      read: () => Promise.resolve("  hello  \n"),
    });
    expect(result).toBe("  hello  \n");
  });

  test("does not call read when stdin is a TTY", async () => {
    let called = false;
    await readPipedInput({
      isTTY: true,
      read: () => {
        called = true;
        return Promise.resolve("content");
      },
    });
    expect(called).toBe(false);
  });
});
