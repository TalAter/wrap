import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { createElement, useEffect } from "react";
import { stripAnsi } from "../src/core/ansi.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL, useSpinner } from "../src/tui/spinner.ts";

describe("useSpinner", () => {
  function Probe({
    active,
    onFrame,
  }: {
    active: boolean;
    onFrame: (frame: string | null) => void;
  }) {
    const frame = useSpinner(active);
    useEffect(() => {
      onFrame(frame);
    }, [frame, onFrame]);
    return createElement(Text, null, frame ?? " ");
  }

  test("returns null when inactive", () => {
    let captured: string | null | undefined;
    render(
      createElement(Probe, {
        active: false,
        onFrame: (f) => {
          captured = f;
        },
      }),
    );
    expect(captured).toBeNull();
  });

  test("returns a frame when active", async () => {
    let captured: string | null | undefined;
    render(
      createElement(Probe, {
        active: true,
        onFrame: (f) => {
          captured = f;
        },
      }),
    );
    expect(captured).not.toBeNull();
    expect(SPINNER_FRAMES).toContain(captured as string);
  });

  test("advances frame over time when active", async () => {
    const seen = new Set<string>();
    render(
      createElement(Probe, {
        active: true,
        onFrame: (f) => {
          if (f !== null) seen.add(f);
        },
      }),
    );
    await new Promise((r) => setTimeout(r, SPINNER_INTERVAL * 3 + 30));
    // Should have observed at least 2 distinct frames in that window.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  test("stops advancing when active flips to false", async () => {
    let captured: string | null = "init";
    const { rerender } = render(
      createElement(Probe, {
        active: true,
        onFrame: (f) => {
          captured = f;
        },
      }),
    );
    await new Promise((r) => setTimeout(r, SPINNER_INTERVAL + 10));
    rerender(
      createElement(Probe, {
        active: false,
        onFrame: (f) => {
          captured = f;
        },
      }),
    );
    // After deactivation, captured should be null. Wait long enough that any
    // leaked interval would have fired.
    await new Promise((r) => setTimeout(r, SPINNER_INTERVAL * 2));
    expect(captured).toBeNull();
  });

  test("renders a visible frame in Ink output", () => {
    const { lastFrame } = render(
      createElement(Probe, {
        active: true,
        onFrame: () => {},
      }),
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // Compare against trimmed frames — Ink strips trailing whitespace from
    // the rendered output, so " " padding inside a frame won't survive.
    expect(SPINNER_FRAMES.some((f) => frame.includes(f.trim()))).toBe(true);
  });
});
