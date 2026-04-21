import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  emit,
  type Notification,
  notifications,
  resetNotifications,
  subscribe,
} from "../src/core/notify.ts";
import { capturedStderr as stderr } from "./preload.ts";

beforeEach(() => {
  resetNotifications();
});

afterEach(() => {
  resetNotifications();
});

describe("notifications bus", () => {
  test("subscribe → emit → listener called", () => {
    const seen: Notification[] = [];
    subscribe((n) => seen.push(n));
    emit({ kind: "chrome", text: "hello" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ kind: "chrome", text: "hello" });
  });

  test("unsubscribe → emit → listener not called", () => {
    const seen: Notification[] = [];
    const unsub = subscribe((n) => seen.push(n));
    unsub();
    emit({ kind: "chrome", text: "hello" });
    expect(seen).toHaveLength(0);
  });

  test("multiple listeners receive emits", () => {
    const a: Notification[] = [];
    const b: Notification[] = [];
    subscribe((n) => a.push(n));
    subscribe((n) => b.push(n));
    emit({ kind: "chrome", text: "hi" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("no listener subscribed → emit writes to stderr", () => {
    emit({ kind: "chrome", text: "hello" });
    expect(stderr.text).toContain("hello");
  });

  test("listener throws → emit doesn't crash; other listeners still receive", () => {
    const seen: Notification[] = [];
    subscribe(() => {
      throw new Error("oops");
    });
    subscribe((n) => seen.push(n));
    expect(() => emit({ kind: "chrome", text: "hi" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  test("resetNotifications clears all listeners", () => {
    const seen: Notification[] = [];
    subscribe((n) => seen.push(n));
    resetNotifications();
    emit({ kind: "chrome", text: "hi" });
    expect(seen).toHaveLength(0);
  });

  test("notifications namespace exposes emit and subscribe", () => {
    const seen: Notification[] = [];
    const unsub = notifications.subscribe((n) => seen.push(n));
    notifications.emit({ kind: "chrome", text: "via namespace" });
    unsub();
    expect(seen).toHaveLength(1);
  });

  test("chrome notification with icon writes icon prefix to stderr", () => {
    emit({ kind: "chrome", text: "thinking", icon: "🧠" });
    expect(stderr.text).toBe("🧠 thinking\n");
  });

  test("chrome notification without icon writes plain text", () => {
    emit({ kind: "chrome", text: "plain" });
    expect(stderr.text).toBe("plain\n");
  });

  test("verbose notification writes the line to stderr verbatim", () => {
    emit({ kind: "verbose", line: "raw verbose line\n" });
    expect(stderr.text).toBe("raw verbose line\n");
  });

  test("llm-wire is dropped on the no-listener path (listener-only)", () => {
    emit({ kind: "llm-wire", wire: { request_wire: { kind: "test" } } });
    expect(stderr.text).toBe("");
  });

  test("llm-wire is delivered to subscribed listeners", () => {
    const seen: Notification[] = [];
    subscribe((n) => seen.push(n));
    emit({ kind: "llm-wire", wire: { request_wire: { kind: "test" } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ kind: "llm-wire", wire: { request_wire: { kind: "test" } } });
  });

  test("step-output is dropped on the no-listener path (dialog-only)", () => {
    // step-output carries the captured intermediate command output that was
    // pushed back to the LLM. It's meant for the dialog's output slot
    // (multi-step) — there is no stderr fallback. Without this drop, the
    // initial loop's probe output would flood the user's terminal in
    // `thinking` state.
    emit({ kind: "step-output", text: "captured probe output" });
    expect(stderr.text).toBe("");
  });
});
