import { describe, expect, test } from "bun:test";

describe("confirmCommand", () => {
  test("returns blocked when stderr is not a TTY", async () => {
    // In test subprocess, stderr is piped (not a TTY), so TUI can't render
    const { confirmCommand } = await import("../src/tui/render.ts");
    const result = await confirmCommand("rm -rf /", "high");
    expect(result.result).toBe("blocked");
    expect(result.command).toBe("rm -rf /");
  });
});
