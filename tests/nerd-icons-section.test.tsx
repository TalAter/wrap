import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { setConfig } from "../src/config/store.ts";
import { stripAnsi } from "../src/core/ansi.ts";
import { type NerdIconsResult, NerdIconsSection } from "../src/tui/nerd-icons-section.tsx";

beforeEach(() => {
  setConfig({});
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
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("four icons");
    expect(text).toContain("setup wizard");
  });

  test("selecting Yes returns nerdFonts: true", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(<NerdIconsSection {...cb} />);
    await wait();
    // Yes is the first option (already highlighted), press Enter
    stdin.write("\r");
    await wait();
    expect(cb.result).toEqual({ nerdFonts: true });
  });

  test("selecting No returns nerdFonts: false", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(<NerdIconsSection {...cb} />);
    await wait();
    // Move down to No
    stdin.write("\x1b[B"); // arrow down
    await wait(100);
    // Submit
    stdin.write("\r");
    await wait();
    expect(cb.result).toEqual({ nerdFonts: false });
  });

  test("Esc cancels the wizard", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(<NerdIconsSection {...cb} />);
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(cb.cancelled).toBe(true);
  });
});
