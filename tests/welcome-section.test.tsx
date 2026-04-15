import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { WelcomeSection } from "../src/tui/welcome-section.tsx";
import { seedTestConfig } from "./helpers.ts";

beforeEach(() => {
  seedTestConfig();
});

function makeCallbacks() {
  const state = { done: false, cancelled: false };
  return {
    onDone: () => {
      state.done = true;
    },
    onCancel: () => {
      state.cancelled = true;
    },
    get done() {
      return state.done;
    },
    get cancelled() {
      return state.cancelled;
    },
  };
}

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("WelcomeSection", () => {
  test("renders welcome copy", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(<WelcomeSection {...cb} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Welcome to Wrap");
    expect(text).toContain("one-time setup");
  });

  test("omits the setup wizard badge", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(<WelcomeSection {...cb} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).not.toContain("setup wizard");
  });

  test("Enter advances the wizard", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(<WelcomeSection {...cb} />);
    await wait();
    stdin.write("\r");
    await wait();
    expect(cb.done).toBe(true);
    expect(cb.cancelled).toBe(false);
  });

  test("hides the animation when the terminal is narrower than 150 cols", async () => {
    // ink-testing-library hardcodes stdout.columns to 100 — narrow case.
    const cb = makeCallbacks();
    const { lastFrame } = render(<WelcomeSection {...cb} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).not.toContain("⣿");
  });

  test("Esc cancels the wizard", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(<WelcomeSection {...cb} />);
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(cb.cancelled).toBe(true);
    expect(cb.done).toBe(false);
  });
});
