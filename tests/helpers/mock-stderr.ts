/**
 * Test helper that monkey-patches `process.stderr.write` to capture writes
 * into an in-memory array. Optionally forces `process.stderr.isTTY` to a
 * specific value (used by spinner tests that need the TTY branch on).
 *
 * Always pair with `restore()` in a finally / afterEach to avoid leaking
 * the mock into other tests in the same file.
 */

export type MockStderr = {
  /** Captured chunks in arrival order. */
  lines: string[];
  /** All captured chunks joined into a single string. */
  readonly text: string;
  /** Reset captured lines to empty without restoring the mock. */
  clear(): void;
  /** Restore the original `process.stderr.write` (and `isTTY` if set). */
  restore(): void;
};

export type MockStderrOptions = {
  /** Force `process.stderr.isTTY` to this value while mocked. */
  isTTY?: boolean;
};

export function mockStderr(options: MockStderrOptions = {}): MockStderr {
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalIsTTY = process.stderr.isTTY;
  if (options.isTTY !== undefined) {
    Object.defineProperty(process.stderr, "isTTY", {
      value: options.isTTY,
      configurable: true,
    });
  }
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    get text() {
      return lines.join("");
    },
    clear() {
      lines.length = 0;
    },
    restore() {
      process.stderr.write = originalWrite;
      if (options.isTTY !== undefined) {
        Object.defineProperty(process.stderr, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    },
  };
}
