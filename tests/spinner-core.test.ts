import { beforeEach, describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { ERASE_LINE, HIDE_CURSOR, SHOW_CURSOR } from "../src/core/ansi.ts";
import {
  resetExitGuard,
  SPINNER_FRAMES,
  SPINNER_INTERVAL,
  SPINNER_TEXT,
  startChromeSpinner,
} from "../src/core/spinner.ts";
import { mockStderr } from "./helpers/mock-stderr.ts";
import { seedTestConfig } from "./helpers.ts";

describe("SPINNER_FRAMES", () => {
  test("all frames have consistent visual width", () => {
    // bottomBorderSegments embeds the frame in a fixed-width slot — frames
    // that disagree on width would shift the trailing dashes each tick.
    const widths = SPINNER_FRAMES.map((f) => stringWidth(f));
    const first = widths[0];
    expect(widths.every((w) => w === first)).toBe(true);
  });
});

describe("startChromeSpinner", () => {
  beforeEach(() => seedTestConfig());

  test("writes the text and a frame to stderr", () => {
    const stderr = mockStderr({ isTTY: true });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      expect(stderr.lines.some((w) => w.includes(SPINNER_TEXT))).toBe(true);
      expect(stderr.lines.some((w) => SPINNER_FRAMES.some((f) => w.includes(f.trim())))).toBe(true);
      stop();
    } finally {
      stderr.restore();
    }
  });

  test("hides the cursor on start and restores it on stop", () => {
    const stderr = mockStderr({ isTTY: true });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      expect(stderr.text).toContain(HIDE_CURSOR);
      stop();
      expect(stderr.text).toContain(SHOW_CURSOR);
    } finally {
      stderr.restore();
    }
  });

  test("stop clears the line so the spinner disappears", () => {
    const stderr = mockStderr({ isTTY: true });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      stop();
      // Last write must contain a CR + erase-in-line so the spinner row
      // is empty when subsequent stderr output lands.
      const tail = stderr.lines[stderr.lines.length - 1] ?? "";
      expect(tail).toContain("\r");
      expect(tail).toContain("\x1b[2K");
    } finally {
      stderr.restore();
    }
  });

  test("advances frames on the configured interval", async () => {
    const stderr = mockStderr({ isTTY: true });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      await new Promise((r) => setTimeout(r, SPINNER_INTERVAL * 3 + 30));
      stop();
      // Should have observed at least 2 different frames during the window.
      const seen = new Set<string>();
      for (const w of stderr.lines) {
        for (const f of SPINNER_FRAMES) {
          if (w.includes(f.trim())) seen.add(f);
        }
      }
      expect(seen.size).toBeGreaterThanOrEqual(2);
    } finally {
      stderr.restore();
    }
  });

  test("does not animate or hide cursor when config.noAnimation is true", async () => {
    seedTestConfig({ noAnimation: true });
    const stderr = mockStderr({ isTTY: true });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      await new Promise((r) => setTimeout(r, SPINNER_INTERVAL * 3 + 30));
      stop();
      expect(stderr.text).not.toContain(HIDE_CURSOR);
      // No spinner frames rendered — only the text itself.
      const seenFrames = SPINNER_FRAMES.filter((f) =>
        stderr.lines.some((w) => w.includes(f.trim())),
      );
      expect(seenFrames).toEqual([]);
      // Status text still shown.
      expect(stderr.lines.some((w) => w.includes(SPINNER_TEXT))).toBe(true);
    } finally {
      stderr.restore();
    }
  });

  test("stop clears the line in noAnimation mode", () => {
    seedTestConfig({ noAnimation: true });
    const stderr = mockStderr({ isTTY: true });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      stop();
      // Last write must contain a CR + erase-in-line so the status row is
      // empty after stop — without it, the text would linger on the user's
      // terminal once the LLM call returns.
      const tail = stderr.lines[stderr.lines.length - 1] ?? "";
      expect(tail).toContain("\r");
      expect(tail).toContain(ERASE_LINE);
    } finally {
      stderr.restore();
    }
  });

  test("no-op when stderr is not a TTY", () => {
    const stderr = mockStderr({ isTTY: false });
    try {
      const stop = startChromeSpinner(SPINNER_TEXT);
      stop();
      expect(stderr.lines).toHaveLength(0);
    } finally {
      stderr.restore();
    }
  });
});

describe("cursor leak guard", () => {
  function withGuardCapture<T>(
    fn: (ctx: {
      exitListeners: Array<() => void>;
      sigintListeners: Array<() => void>;
      sigtermListeners: Array<() => void>;
      writes: string[];
    }) => T,
  ): T {
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
