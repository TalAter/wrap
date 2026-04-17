/**
 * Shared core for `mockStdout` / `mockStderr`. Captures writes to the given
 * stream into an in-memory array and optionally forces `isTTY`.
 *
 * When target is `"stdout"`, also patches `console.log` — Bun's `console.log`
 * writes directly to fd 1 without going through `process.stdout.write`.
 * `console.error` is NOT patched for the `"stderr"` target because production
 * code never uses it (chrome/verbose route through `process.stderr.write`).
 *
 * Always pair with `restore()` in a finally / afterEach to avoid leaking the
 * mock into other tests in the same file.
 */

export type StreamTarget = "stdout" | "stderr";

export type MockStream = {
  lines: string[];
  readonly text: string;
  clear(): void;
  restore(): void;
};

export type MockStreamOptions = {
  isTTY?: boolean;
};

export function mockStream(target: StreamTarget, options: MockStreamOptions = {}): MockStream {
  const stream = process[target];
  const lines: string[] = [];
  const originalWrite = stream.write.bind(stream);
  const originalIsTTY = stream.isTTY;
  const originalConsoleLog = target === "stdout" ? console.log : undefined;

  if (options.isTTY !== undefined) {
    Object.defineProperty(stream, "isTTY", { value: options.isTTY, configurable: true });
  }

  stream.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof stream.write;

  if (target === "stdout") {
    console.log = (...args: unknown[]) => {
      lines.push(`${args.map((a) => String(a)).join(" ")}\n`);
    };
  }

  return {
    lines,
    get text() {
      return lines.join("");
    },
    clear() {
      lines.length = 0;
    },
    restore() {
      stream.write = originalWrite;
      if (originalConsoleLog) console.log = originalConsoleLog;
      if (options.isTTY !== undefined) {
        Object.defineProperty(stream, "isTTY", { value: originalIsTTY, configurable: true });
      }
    },
  };
}
