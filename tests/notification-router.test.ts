import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Notification, notifications, resetNotifications } from "../src/core/notify.ts";
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

function makeRouter(opts?: { isDialogLive?: boolean }) {
  const seen: Notification[] = [];
  const router = createNotificationRouter({
    onDialogNotification: (n) => seen.push(n),
    isDialogLive: () => opts?.isDialogLive ?? false,
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

  test("isDialogLive=true: all notifications call onDialogNotification", () => {
    let live = false;
    const seen: Notification[] = [];
    const router = createNotificationRouter({
      onDialogNotification: (n) => seen.push(n),
      isDialogLive: () => live,
    });
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());

    live = false;
    notifications.emit({ kind: "chrome", text: "ignored" });
    expect(seen).toHaveLength(0);

    live = true;
    notifications.emit({ kind: "chrome", text: "chrome-live" });
    notifications.emit({ kind: "step-output", text: "step-live" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ kind: "chrome", text: "chrome-live" });
    expect(seen[1]).toEqual({ kind: "step-output", text: "step-live" });

    unsub();
  });

  test("step-output is forwarded to onDialogNotification when live", () => {
    // Regression: multi-step needs step-output to reach the reducer while
    // the dialog is in processing OR executing-step. The old router only
    // forwarded chrome; step-output was dropped silently.
    const { router, seen } = makeRouter({ isDialogLive: true });
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());
    notifications.emit({ kind: "step-output", text: "captured body" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ kind: "step-output", text: "captured body" });
    unsub();
  });

  test("full lifecycle: stderr → buffered → flushed", () => {
    // The exact sequence the coordinator drives over a session: subscribe
    // first (no dialog yet → goes to stderr), then mount the dialog (next
    // emit is buffered), then teardown (buffered emit flushes to stderr).
    const { router } = makeRouter();
    const unsub = router.subscribe();

    notifications.emit({ kind: "chrome", text: "before-mount" });
    expect(stderr.text).toContain("before-mount");
    expect(stderr.text).not.toContain("during-mount");

    router.setDialog(makeFakeDialog());
    notifications.emit({ kind: "chrome", text: "during-mount" });
    // Buffered, not yet on stderr.
    expect(stderr.text).not.toContain("during-mount");

    router.teardownDialog();
    expect(stderr.text).toContain("during-mount");

    // After teardown, the next emit goes to stderr again.
    notifications.emit({ kind: "chrome", text: "after-teardown" });
    expect(stderr.text).toContain("after-teardown");

    unsub();
  });

  test("isDialogMounted reflects setDialog / teardownDialog", () => {
    const { router } = makeRouter();
    expect(router.isDialogMounted()).toBe(false);
    router.setDialog(makeFakeDialog());
    expect(router.isDialogMounted()).toBe(true);
    router.teardownDialog();
    expect(router.isDialogMounted()).toBe(false);
  });

  test("getDialog returns the mounted host or null", () => {
    const { router } = makeRouter();
    expect(router.getDialog()).toBeNull();
    const host = makeFakeDialog();
    router.setDialog(host);
    expect(router.getDialog()).toBe(host);
    router.teardownDialog();
    expect(router.getDialog()).toBeNull();
  });

  test("step-output buffered during dialog window is dropped on flush, not leaked to stderr", () => {
    // Captured probe output is dialog-only — `writeNotificationToStderr`
    // makes step-output a no-op so a buffered step-output never lands in
    // scrollback even after teardown.
    const { router } = makeRouter();
    const unsub = router.subscribe();
    router.setDialog(makeFakeDialog());
    notifications.emit({ kind: "step-output", text: "SECRET_OUTPUT" });
    router.teardownDialog();
    expect(stderr.text).not.toContain("SECRET_OUTPUT");
    unsub();
  });
});
