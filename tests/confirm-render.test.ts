import { afterAll, beforeAll, describe, expect, test } from "bun:test";

describe("confirmCommand", () => {
  const origIsTTY = process.stderr.isTTY;

  beforeAll(() => {
    // Force non-TTY so the TUI never opens (avoids SIGTTIN suspension
    // when tests run in a real terminal)
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
  });

  test("returns blocked when stderr is not a TTY", async () => {
    const { confirmCommand } = await import("../src/tui/render.ts");
    const result = await confirmCommand("rm -rf /", "high");
    expect(result.result).toBe("blocked");
    expect(result.command).toBe("rm -rf /");
  });
});
