/**
 * Test helper that optionally forces `process.stdin.isTTY` and/or swaps
 * `process.stdin.setRawMode` with a spy. Mirrors `mock-stderr.ts`.
 *
 * Always pair with `restore()` in a finally / afterEach.
 */

export type MockStdin = {
  /** True once `setRawMode` has been called through the spy. */
  readonly setRawModeCalled: boolean;
  restore(): void;
};

export type MockStdinOptions = {
  isTTY?: boolean;
  /** When true, replace `setRawMode` with a no-op spy. */
  spySetRawMode?: boolean;
};

export function mockStdin(options: MockStdinOptions = {}): MockStdin {
  const originalIsTTY = process.stdin.isTTY;
  const originalSetRawMode = process.stdin.setRawMode?.bind(process.stdin);
  let called = false;

  if (options.isTTY !== undefined) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: options.isTTY,
      configurable: true,
    });
  }

  if (options.spySetRawMode) {
    process.stdin.setRawMode = (() => {
      called = true;
      return process.stdin;
    }) as unknown as typeof process.stdin.setRawMode;
  }

  return {
    get setRawModeCalled() {
      return called;
    },
    restore() {
      if (options.isTTY !== undefined) {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
      if (options.spySetRawMode && originalSetRawMode) {
        process.stdin.setRawMode = originalSetRawMode;
      }
    },
  };
}
