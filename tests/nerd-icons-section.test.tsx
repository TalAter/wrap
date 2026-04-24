import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { type NerdIconsResult, NerdIconsSection } from "../src/tui/nerd-icons-section.tsx";
import { seedTestConfig, waitFor } from "./helpers.ts";

beforeEach(() => {
  seedTestConfig();
});

function makeCallbacks() {
  const state = { result: null as NerdIconsResult | null, cancelled: false };
  return {
    onDone: (result: NerdIconsResult) => {
      state.result = result;
    },
    onCancel: () => {
      state.cancelled = true;
    },
    get result() {
      return state.result;
    },
    get cancelled() {
      return state.cancelled;
    },
  };
}

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("NerdIconsSection", () => {
  test("renders icon detection prompt", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(<NerdIconsSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("four icons"));
    expect(stripAnsi(lastFrame() ?? "")).toContain("Setup Wizard");
  });

  test("selecting Yes returns nerdFonts: true", async () => {
    const cb = makeCallbacks();
    const { stdin, lastFrame } = render(<NerdIconsSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("four icons"));
    // Yes is the first option (already highlighted), press Enter
    stdin.write("\r");
    await waitFor(() => expect(cb.result).toEqual({ nerdFonts: true }));
  });

  test("selecting No returns nerdFonts: false", async () => {
    const cb = makeCallbacks();
    const { stdin, lastFrame } = render(<NerdIconsSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("four icons"));
    // Move down to No
    stdin.write("\x1b[B"); // arrow down
    await wait();
    // Submit
    stdin.write("\r");
    await waitFor(() => expect(cb.result).toEqual({ nerdFonts: false }));
  });

  test("Esc cancels the wizard", async () => {
    const cb = makeCallbacks();
    const { stdin, lastFrame } = render(<NerdIconsSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("four icons"));
    stdin.write("\x1b");
    await waitFor(() => expect(cb.cancelled).toBe(true));
  });
});
