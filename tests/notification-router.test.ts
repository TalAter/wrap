import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Notification, resetNotifications, notifications } from "../src/core/notify.ts";
import type { DialogHost } from "../src/session/dialog-host.ts";
import { createNotificationRouter } from "../src/session/notification-router.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

let stderr: MockStderr;

beforeEach(() => {
  resetNotifications();
  stderr = mockStderr();
});

afterEach(() => {
  stderr.restore();
  resetNotifications();
});

function makeFakeDialog(): DialogHost & { unmounted: boolean } {
  const host = {
    unmounted: false,
    rerender: () => {},
    unmount() {
      this.unmounted = true;
    },
  };
  return host;
}

function makeRouter(opts?: { isProcessing?: boolean }) {
  const seen: Notification[] = [];
  const router = createNotificationRouter({
    onProcessingChrome: (n) => seen.push(n),
    isProcessing: () => opts?.isProcessing ?? false,
  });
  return { router, seen };
}

describe("createNotificationRouter", () => {
  test("with no dialog set, emits go straight to stderr", () => {
    const { router } = makeRouter();
    const unsub = router.subscribe();
    notifications.emit({ kind: "chrome", text: "hello" });
    unsub();
    expect(stderr.text).toContain("hello");
  });

  test("with a dialog set, emits are buffered (not written to stderr)", () => {
    const { router } = makeRouter();
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());
    notifications.emit({ kind: "chrome", text: "buffered" });
    expect(stderr.text).not.toContain("buffered");
    unsub();
  });

  test("teardownDialog flushes buffered notifications to stderr", () => {
    const { router } = makeRouter();
    const unsub = router.subscribe();
    const host = makeFakeDialog();
    router.setDialog(host);
    notifications.emit({ kind: "chrome", text: "first" });
    notifications.emit({ kind: "chrome", text: "second" });
    expect(stderr.text).toBe("");
    router.teardownDialog();
    expect(host.unmounted).toBe(true);
    expect(stderr.text).toContain("first");
    expect(stderr.text).toContain("second");
    unsub();
  });

  test("teardownDialog is idempotent", () => {
    const { router } = makeRouter();
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());
    router.teardownDialog();
    expect(() => router.teardownDialog()).not.toThrow();
    unsub();
  });

  test("teardownDialog with no dialog set is a no-op", () => {
    const { router } = makeRouter();
    expect(() => router.teardownDialog()).not.toThrow();
  });

  test("flushed lines are written AFTER unmount (alt-screen ordering)", () => {
    // The dialog's unmount writes EXIT_ALT_SCREEN to stderr; we mock that by
    // recording the order. Flushed buffered lines must arrive after the
    // unmount marker so they land in real scrollback.
    const { router } = makeRouter();
    const unsub = router.subscribe();
    const host: DialogHost = {
      rerender: () => {},
      unmount: () => {
        process.stderr.write("UNMOUNT\n");
      },
    };
    router.setDialog(host);
    notifications.emit({ kind: "chrome", text: "buffered-line" });
    router.teardownDialog();
    const unmountIdx = stderr.text.indexOf("UNMOUNT");
    const lineIdx = stderr.text.indexOf("buffered-line");
    expect(unmountIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(unmountIdx);
    unsub();
  });

  test("isProcessing=true: chrome notifications also call onProcessingChrome", () => {
    let processing = false;
    const seen: Notification[] = [];
    const router = createNotificationRouter({
      onProcessingChrome: (n) => seen.push(n),
      isProcessing: () => processing,
    });
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());

    processing = false;
    notifications.emit({ kind: "chrome", text: "ignored" });
    expect(seen).toHaveLength(0);

    processing = true;
    notifications.emit({ kind: "chrome", text: "live" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ kind: "chrome", text: "live" });

    unsub();
  });

  test("non-chrome notifications never call onProcessingChrome", () => {
    const { router, seen } = makeRouter({ isProcessing: true });
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());
    notifications.emit({ kind: "verbose", line: "ignored\n" });
    notifications.emit({ kind: "step-output", text: "also ignored" });
    expect(seen).toHaveLength(0);
    unsub();
  });
});
