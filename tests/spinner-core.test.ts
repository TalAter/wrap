import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { HIDE_CURSOR, SHOW_CURSOR } from "../src/core/ansi.ts";
import {
  resetExitGuard,
  SPINNER_FRAMES,
  SPINNER_INTERVAL,
  SPINNER_TEXT,
  startChromeSpinner,
} from "../src/core/spinner.ts";

describe("SPINNER_FRAMES", () => {
  test("has frames", () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThan(0);
  });

  test("all frames have consistent visual width", () => {
    // bottomBorderSegments embeds the frame in a fixed-width slot — frames
    // that disagree on width would shift the trailing dashes each tick.
    const widths = SPINNER_FRAMES.map((f) => stringWidth(f));
    const first = widths[0];
    expect(widths.every((w) => w === first)).toBe(true);
  });
});

describe("SPINNER_INTERVAL", () => {
  test("is a positive number", () => {
    expect(SPINNER_INTERVAL).toBeGreaterThan(0);
  });
});

describe("startChromeSpinner", () => {
  async function captureStderr<T>(fn: (writes: string[]) => T | Promise<T>): Promise<T> {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // Force the TTY branch on inside startChromeSpinner; process.stderr in
    // tests has no isTTY (false) so without this the spinner would no-op.
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    process.stderr.write = ((s: string) => {
      writes.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      return await fn(writes);
    } finally {
      process.stderr.write = original;
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  }

  test("writes the text and a frame to stderr", async () => {
    await captureStderr(async (writes) => {
      const stop = startChromeSpinner(SPINNER_TEXT);
      expect(writes.some((w) => w.includes(SPINNER_TEXT))).toBe(true);
      expect(writes.some((w) => SPINNER_FRAMES.some((f) => w.includes(f.trim())))).toBe(true);
      stop();
    });
  });

  test("hides the cursor on start and restores it on stop", async () => {
    await captureStderr(async (writes) => {
      const stop = startChromeSpinner(SPINNER_TEXT);
      expect(writes.some((w) => w.includes(HIDE_CURSOR))).toBe(true);
      stop();
      expect(writes.some((w) => w.includes(SHOW_CURSOR))).toBe(true);
    });
  });

  test("stop clears the line so the spinner disappears", async () => {
    await captureStderr(async (writes) => {
      const stop = startChromeSpinner(SPINNER_TEXT);
      stop();
      // Last write must contain a CR + erase-in-line so the spinner row
      // is empty when subsequent stderr output lands.
      const tail = writes[writes.length - 1] ?? "";
      expect(tail).toContain("\r");
      expect(tail).toContain("\x1b[2K");
    });
  });

  test("advances frames on the configured interval", async () => {
    await captureStderr(async (writes) => {
      const stop = startChromeSpinner(SPINNER_TEXT);
      await new Promise((r) => setTimeout(r, SPINNER_INTERVAL * 3 + 30));
      stop();
      // Should have observed at least 2 different frames during the window.
      const seen = new Set<string>();
      for (const w of writes) {
        for (const f of SPINNER_FRAMES) {
          if (w.includes(f.trim())) seen.add(f);
        }
      }
      expect(seen.size).toBeGreaterThanOrEqual(2);
    });
  });

  test("no-op when stderr is not a TTY", () => {
    // Don't use captureStderr — we want isTTY=false.
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      writes.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      stop();
      expect(writes).toHaveLength(0);
    } finally {
      process.stderr.write = original;
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});

describe("cursor leak guard", () => {
  function withGuardCapture<T>(fn: (ctx: {
    exitListeners: Array<() => void>;
    sigintListeners: Array<() => void>;
    sigtermListeners: Array<() => void>;
    writes: string[];
  }) => T): T {
    // Reset module state so the install runs on the first call inside the
    // test, with our process.on mock in place.
    resetExitGuard();
    const originalIsTTY = process.stderr.isTTY;
    const originalOn = process.on.bind(process);
    const originalWrite = process.stderr.write.bind(process.stderr);
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    const exitListeners: Array<() => void> = [];
    const sigintListeners: Array<() => void> = [];
    const sigtermListeners: Array<() => void> = [];
    process.on = ((event: string, listener: () => void) => {
      if (event === "exit") exitListeners.push(listener);
      else if (event === "SIGINT") sigintListeners.push(listener);
      else if (event === "SIGTERM") sigtermListeners.push(listener);
      return process;
    }) as typeof process.on;
    const writes: string[] = [];
    process.stderr.write = ((s: string) => {
      writes.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      return fn({ exitListeners, sigintListeners, sigtermListeners, writes });
    } finally {
      process.on = originalOn;
      process.stderr.write = originalWrite;
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  }

  test("the registered exit handler restores the cursor", () => {
    withGuardCapture(({ exitListeners, writes }) => {
      const stop = startChromeSpinner(SPINNER_TEXT);
      try {
        expect(exitListeners.length).toBeGreaterThanOrEqual(1);
        writes.length = 0;
        // Simulate process exit while the spinner is still running.
        for (const listener of exitListeners) listener();
        expect(writes.some((w) => w.includes(SHOW_CURSOR))).toBe(true);
      } finally {
        stop();
      }
    });
  });

  test("installs the exit handler exactly once across multiple spinner runs", () => {
    withGuardCapture(({ exitListeners }) => {
      const startCount = exitListeners.length;
      const stop1 = startChromeSpinner(SPINNER_TEXT);
      stop1();
      const stop2 = startChromeSpinner(SPINNER_TEXT);
      stop2();
      const stop3 = startChromeSpinner(SPINNER_TEXT);
      stop3();
      expect(exitListeners.length - startCount).toBe(1);
    });
  });

  test("registers SIGINT and SIGTERM handlers alongside exit", () => {
    withGuardCapture(({ sigintListeners, sigtermListeners }) => {
      const stop = startChromeSpinner(SPINNER_TEXT);
      try {
        expect(sigintListeners.length).toBeGreaterThanOrEqual(1);
        expect(sigtermListeners.length).toBeGreaterThanOrEqual(1);
      } finally {
        stop();
      }
    });
  });
});
