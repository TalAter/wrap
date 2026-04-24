import { describe, expect, test } from "bun:test";
import { chooseDialogStdin, DIALOG_INK_OPTIONS } from "../src/session/dialog-host.ts";

describe("chooseDialogStdin", () => {
  test("returns process.stdin when parent has a TTY", () => {
    const { stream, fd } = chooseDialogStdin({ isTTY: true });
    expect(stream).toBe(process.stdin);
    expect(fd).toBeNull();
  });

  test("opens /dev/tty and returns a ReadStream with isTTY=true when piped", () => {
    let opened = false;
    const { stream, fd } = chooseDialogStdin({
      isTTY: false,
      tryOpenTty: () => {
        opened = true;
        return 99;
      },
    });
    expect(opened).toBe(true);
    expect(fd).toBe(99);
    expect((stream as unknown as { isTTY: boolean }).isTTY).toBe(true);
  });

  test("falls back to process.stdin when /dev/tty open fails", () => {
    const { stream, fd } = chooseDialogStdin({
      isTTY: false,
      tryOpenTty: () => {
        throw new Error("ENXIO");
      },
    });
    expect(stream).toBe(process.stdin);
    expect(fd).toBeNull();
  });

  test("treats isTTY undefined as non-TTY", () => {
    let opened = false;
    chooseDialogStdin({
      isTTY: undefined,
      tryOpenTty: () => {
        opened = true;
        return 7;
      },
    });
    expect(opened).toBe(true);
  });
});

describe("DIALOG_INK_OPTIONS", () => {
  // Ink defaults exitOnCtrlC to true, which short-circuits every useInput
  // listener for Ctrl+C (ink/build/hooks/use-input.js:104). Our key-binding
  // layer owns Ctrl+C → key-esc, so Ink must not swallow it in raw mode.
  test("sets exitOnCtrlC: false so our key-binding layer handles Ctrl+C", () => {
    expect(DIALOG_INK_OPTIONS.exitOnCtrlC).toBe(false);
  });
});
