import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { WelcomeSection } from "../src/tui/welcome-section.tsx";
import { seedTestConfig, waitFor } from "./helpers.ts";

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

describe("WelcomeSection", () => {
  test("renders wrap logo and welcome copy", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(<WelcomeSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("██████╗"));
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("a cli with taste");
    expect(text).toContain("one-time setup");
    expect(text).toContain("45 seconds");
  });

  test("Enter advances the wizard", async () => {
    const cb = makeCallbacks();
    const { stdin, lastFrame } = render(<WelcomeSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("a cli with taste"));
    stdin.write("\r");
    await waitFor(() => expect(cb.done).toBe(true));
    expect(cb.cancelled).toBe(false);
  });

  test("hides the animation when the terminal is narrower than 150 cols", async () => {
    // ink-testing-library hardcodes stdout.columns to 100 — narrow case.
    const cb = makeCallbacks();
    const { lastFrame } = render(<WelcomeSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("a cli with taste"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("⣿");
  });

  test("Esc cancels the wizard", async () => {
    const cb = makeCallbacks();
    const { stdin, lastFrame } = render(<WelcomeSection {...cb} />);
    await waitFor(() => expect(stripAnsi(lastFrame() ?? "")).toContain("a cli with taste"));
    stdin.write("\x1b");
    await waitFor(() => expect(cb.cancelled).toBe(true));
    expect(cb.done).toBe(false);
  });
});
