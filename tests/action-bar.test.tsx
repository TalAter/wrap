import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { ActionBar, type ActionItem } from "../src/tui/action-bar.tsx";

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("ActionBar", () => {
  test("renders approve-style letter items with their labels", async () => {
    const items: ActionItem[] = [
      { glyph: "Y", label: "Yes", primary: true },
      { glyph: "N", label: "No", primary: true },
    ];
    const { lastFrame } = render(<ActionBar items={items} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
  });

  test("renders combo-prefix items with glyph then label", async () => {
    const items: ActionItem[] = [
      { glyph: "⏎", label: "to run", primary: true },
      { glyph: "Esc", label: "to cancel" },
    ];
    const { lastFrame } = render(<ActionBar items={items} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("⏎ to run");
    expect(text).toContain("Esc to cancel");
  });

  test("renders the shared divider between items", async () => {
    const items: ActionItem[] = [
      { glyph: "⏎", label: "to run" },
      { glyph: "Esc", label: "to cancel" },
    ];
    const { lastFrame } = render(<ActionBar items={items} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("│");
  });

  test("focusedIndex does not strip any label text", async () => {
    const items: ActionItem[] = [
      { glyph: "Y", label: "Yes", primary: true },
      { glyph: "N", label: "No", primary: true },
    ];
    const { lastFrame } = render(<ActionBar items={items} focusedIndex={1} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
  });

  test("focusedIndex out of range does not crash", async () => {
    const items: ActionItem[] = [{ glyph: "Y", label: "Yes" }];
    const { lastFrame } = render(<ActionBar items={items} focusedIndex={5} />);
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Yes");
  });

  test("mixed items (letter + combo) both render", async () => {
    const items: ActionItem[] = [
      { glyph: "Y", label: "Yes", primary: true },
      { glyph: "Esc", label: "to cancel" },
    ];
    const { lastFrame } = render(<ActionBar items={items} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Yes");
    expect(text).toContain("Esc to cancel");
    expect(text).toContain("│");
  });

  test("renders items flush with no built-in left padding", async () => {
    // Callers own left indentation via Box paddingLeft; ActionBar is pure items.
    const { lastFrame } = render(<ActionBar items={[{ glyph: "⏎", label: "x" }]} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text.startsWith("⏎")).toBe(true);
  });

  test("dividerAfter=[] renders no dividers between items", async () => {
    const items: ActionItem[] = [
      { glyph: "A", label: "Alpha" },
      { glyph: "B", label: "Beta" },
      { glyph: "G", label: "Gamma" },
    ];
    const { lastFrame } = render(<ActionBar items={items} dividerAfter={[]} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).not.toContain("│");
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain("Gamma");
  });

  test("dividerAfter=[1] places exactly one divider between items 1 and 2", async () => {
    const items: ActionItem[] = [
      { glyph: "A", label: "Alpha" },
      { glyph: "B", label: "Beta" },
      { glyph: "G", label: "Gamma" },
      { glyph: "D", label: "Delta" },
    ];
    const { lastFrame } = render(<ActionBar items={items} dividerAfter={[1]} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    const pipeCount = (text.match(/│/g) ?? []).length;
    expect(pipeCount).toBe(1);
    // Divider must fall between Beta and Gamma.
    const betaIdx = text.indexOf("Beta");
    const gammaIdx = text.indexOf("Gamma");
    const pipeIdx = text.indexOf("│");
    expect(pipeIdx).toBeGreaterThan(betaIdx);
    expect(pipeIdx).toBeLessThan(gammaIdx);
  });
});
