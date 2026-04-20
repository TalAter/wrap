import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import type { Footprints } from "../src/tui/forget-dialog.tsx";
import { ForgetDialog } from "../src/tui/forget-dialog.tsx";
import { seedTestConfig } from "./helpers.ts";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const FULL_FOOTPRINTS: Footprints = {
  memory: { state: "ok", count: 23, bytes: 4096 },
  logs: { state: "ok", count: 1203, bytes: 4 * 1024 * 1024 },
  cache: { state: "ok", count: 2, bytes: 18 * 1024 },
  scratch: { state: "ok", count: 3, bytes: 112 * 1024 * 1024 },
};

type SpyResult = {
  submitted: string[] | null;
  cancelled: boolean;
};

function makeCallbacks(): {
  onSubmit: (v: string[]) => void;
  onCancel: () => void;
  result: SpyResult;
} {
  const result: SpyResult = { submitted: null, cancelled: false };
  return {
    result,
    onSubmit: (v) => {
      result.submitted = v;
    },
    onCancel: () => {
      result.cancelled = true;
    },
  };
}

beforeEach(() => {
  seedTestConfig();
});

describe("ForgetDialog", () => {
  test("renders all four buckets with footprint labels", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(
      <ForgetDialog footprints={FULL_FOOTPRINTS} onSubmit={cb.onSubmit} onCancel={cb.onCancel} />,
    );
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Memory");
    expect(text).toContain("Logs");
    expect(text).toContain("Cache");
    expect(text).toContain("Temp files");
    expect(text).toContain("23 facts");
    expect(text).toContain("1,203 entries");
    expect(text).toContain("2 files");
    expect(text).toContain("3 dirs");
  });

  test("shows (empty) for buckets with nothing to delete", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(
      <ForgetDialog
        footprints={{
          memory: { state: "empty" },
          logs: { state: "empty" },
          cache: { state: "empty" },
          scratch: { state: "empty" },
        }}
        onSubmit={cb.onSubmit}
        onCancel={cb.onCancel}
      />,
    );
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("(empty)");
  });

  test("shows (unreadable) for corrupt memory", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(
      <ForgetDialog
        footprints={{
          ...FULL_FOOTPRINTS,
          memory: { state: "unreadable" },
        }}
        onSubmit={cb.onSubmit}
        onCancel={cb.onCancel}
      />,
    );
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("(unreadable)");
  });

  test("all four items checked by default — Enter submits all", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(
      <ForgetDialog footprints={FULL_FOOTPRINTS} onSubmit={cb.onSubmit} onCancel={cb.onCancel} />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(cb.result.submitted?.sort()).toEqual(["cache", "logs", "memory", "scratch"]);
  });

  test("empty buckets still checked by default", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(
      <ForgetDialog
        footprints={{
          memory: { state: "empty" },
          logs: { state: "empty" },
          cache: { state: "empty" },
          scratch: { state: "empty" },
        }}
        onSubmit={cb.onSubmit}
        onCancel={cb.onCancel}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(cb.result.submitted?.sort()).toEqual(["cache", "logs", "memory", "scratch"]);
  });

  test("Space toggles the focused item off, Enter submits the rest", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(
      <ForgetDialog footprints={FULL_FOOTPRINTS} onSubmit={cb.onSubmit} onCancel={cb.onCancel} />,
    );
    await wait();
    // Cursor starts on first item (memory) — toggle it off.
    stdin.write(" ");
    await wait();
    stdin.write("\r");
    await wait();
    expect(cb.result.submitted).not.toContain("memory");
    expect(cb.result.submitted?.length).toBe(3);
  });

  test("Esc triggers onCancel", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(
      <ForgetDialog footprints={FULL_FOOTPRINTS} onSubmit={cb.onSubmit} onCancel={cb.onCancel} />,
    );
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(cb.result.cancelled).toBe(true);
    expect(cb.result.submitted).toBeNull();
  });

  test("Empty submit (all toggled off + Enter) fires onSubmit with []", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(
      <ForgetDialog footprints={FULL_FOOTPRINTS} onSubmit={cb.onSubmit} onCancel={cb.onCancel} />,
    );
    await wait();
    // Toggle each of the four items off (cursor stays on row 0 across toggles? no, space just toggles current row)
    // Move cursor + toggle in pairs.
    stdin.write(" "); // toggle memory off
    await wait();
    stdin.write("\x1b[B"); // down
    await wait();
    stdin.write(" "); // toggle logs off
    await wait();
    stdin.write("\x1b[B");
    await wait();
    stdin.write(" "); // toggle cache off
    await wait();
    stdin.write("\x1b[B");
    await wait();
    stdin.write(" "); // toggle scratch off
    await wait();
    stdin.write("\r");
    await wait();
    expect(cb.result.submitted).toEqual([]);
  });
});
