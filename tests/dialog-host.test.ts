import { describe, expect, test } from "bun:test";
import { chooseDialogStdin } from "../src/session/dialog-host.ts";

describe("chooseDialogStdin", () => {
  test("returns process.stdin when parent has a TTY", () => {
    const { stream, fd } = chooseDialogStdin({ isTTY: true });
    expect(stream).toBe(process.stdin);
    expect(fd).toBeNull();
  });

  test("does not attempt to open /dev/tty when parent has a TTY", () => {
    let opened = false;
    chooseDialogStdin({
      isTTY: true,
      tryOpenTty: () => {
        opened = true;
        return 99;
      },
    });
    expect(opened).toBe(false);
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
