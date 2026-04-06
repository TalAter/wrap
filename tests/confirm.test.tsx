import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { ConfirmPanel } from "../src/tui/confirm.tsx";

function extractPanelLines(frame: string): string[] {
  const lines = stripAnsi(frame).split("\n");
  const topIndex = lines.findIndex((line) => line.includes("╭"));
  if (topIndex === -1) return [];

  const bottomIndex = lines.findIndex((line, i) => i > topIndex && line.includes("╰"));
  if (bottomIndex === -1) return [];

  return lines.slice(topIndex, bottomIndex + 1).map((line) => line.trimStart());
}

describe("ConfirmPanel", () => {
  test("renders command text", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain("rm -rf /");
  });

  test("renders risk badge in border", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="chmod 777 ." riskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⚠ medium risk");
  });

  test("renders high risk badge", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⚠ high risk");
  });

  test("shows explanation when provided", () => {
    const { lastFrame } = render(
      <ConfirmPanel
        command="rm file"
        riskLevel="medium"
        explanation="Deletes a file"
        onChoice={() => {}}
      />,
    );
    expect(lastFrame()).toContain("Deletes a file");
  });

  test("shows action bar with Run command prompt", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Run command?");
    expect(frame).toContain("Yes");
    expect(frame).toContain("No");
  });

  test("shows secondary actions in action bar", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Describe");
    expect(frame).toContain("Edit");
    expect(frame).toContain("Follow-up");
    expect(frame).toContain("Copy");
  });

  test("has gradient border corners", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("╭");
    expect(frame).toContain("╮");
    expect(frame).toContain("╰");
    expect(frame).toContain("╯");
  });

  test("has vertical border characters", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("│");
  });

  test("omits explanation line when not provided", () => {
    const withExplanation = render(
      <ConfirmPanel command="rm file" riskLevel="medium" explanation="info" onChoice={() => {}} />,
    );
    const without = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={() => {}} />,
    );
    expect(stripAnsi(withExplanation.lastFrame() ?? "")).toContain("info");
    expect(stripAnsi(without.lastFrame() ?? "")).not.toContain("info");
  });

  test("keeps side borders aligned when explanation wraps", async () => {
    const { lastFrame } = render(
      <ConfirmPanel
        command="rm CLAUDE.md"
        riskLevel="medium"
        explanation="Deletes the file CLAUDE.md from the current directory (/Users/tal/mysite/wrap/.claude/worktrees/tui-plan). This is irreversible and removes it immediately."
        onChoice={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    const panel = extractPanelLines(lastFrame() ?? "");
    const interior = panel.slice(1, -1);
    expect(interior.length).toBeGreaterThan(0);
    expect(
      interior.every((line) => line === "" || (line.startsWith("│") && line.endsWith("│"))),
    ).toBe(true);
  });

  test("reflows on terminal resize without waiting for keyboard input", async () => {
    const app = render(
      <ConfirmPanel
        command="rm /Users/tal/mysite/wrap/CLAUDE.md"
        riskLevel="high"
        explanation="Deletes the CLAUDE.md file in your wrap project directory. This is irreversible and cannot be recovered unless you have git history or backup."
        onChoice={() => {}}
      />,
    );

    await new Promise((r) => setTimeout(r, 10));
    const before = stripAnsi(app.lastFrame() ?? "");
    const beforePanel = extractPanelLines(before);

    Object.defineProperty(app.stdout, "columns", {
      value: 72,
      configurable: true,
    });
    app.stdout.emit("resize");

    await new Promise((r) => setTimeout(r, 10));
    const after = stripAnsi(app.lastFrame() ?? "");
    const afterPanel = extractPanelLines(after);
    const interior = afterPanel.slice(1, -1);

    expect(after).not.toBe(before);
    expect(afterPanel.length).toBeGreaterThan(0);
    expect(afterPanel[0]?.length).toBeLessThan(beforePanel[0]?.length ?? 0);
    expect(interior.every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
  });

  test("keeps top border corners visible on narrow terminals", async () => {
    const app = render(
      <ConfirmPanel
        command="rm /Users/tal/mysite/wrap/CLAUDE.md"
        riskLevel="high"
        explanation="Deletes the CLAUDE.md file in your wrap project directory. This is irreversible and cannot be recovered unless you have git history or backup."
        onChoice={() => {}}
      />,
    );

    await new Promise((r) => setTimeout(r, 10));

    Object.defineProperty(app.stdout, "columns", { value: 50, configurable: true });
    app.stdout.emit("resize");

    await new Promise((r) => setTimeout(r, 20));
    const after = stripAnsi(app.lastFrame() ?? "");
    const panel = extractPanelLines(after);
    const topLine = panel[0] ?? "";

    expect(topLine.startsWith("╭")).toBe(true);
    expect(topLine.endsWith("╮")).toBe(true);
    expect(topLine.length).toBeLessThanOrEqual(50);
  });

  test("uses the latest width after rapid resize bursts", async () => {
    const app = render(
      <ConfirmPanel
        command="rm /Users/tal/mysite/wrap/CLAUDE.md"
        riskLevel="high"
        explanation="Deletes the CLAUDE.md file in your wrap project directory. This is irreversible and cannot be recovered unless you have git history or backup."
        onChoice={() => {}}
      />,
    );

    await new Promise((r) => setTimeout(r, 10));

    Object.defineProperty(app.stdout, "columns", { value: 88, configurable: true });
    app.stdout.emit("resize");
    Object.defineProperty(app.stdout, "columns", { value: 68, configurable: true });
    app.stdout.emit("resize");
    Object.defineProperty(app.stdout, "columns", { value: 76, configurable: true });
    app.stdout.emit("resize");

    await new Promise((r) => setTimeout(r, 20));

    const after = stripAnsi(app.lastFrame() ?? "");
    const panel = extractPanelLines(after);
    const topLine = panel[0] ?? "";

    expect(topLine.startsWith("╭")).toBe(true);
    expect(topLine.endsWith("╮")).toBe(true);
    expect(topLine.length).toBeLessThanOrEqual(72);
    expect(after).toContain("⚠ high risk");
  });
});

describe("ConfirmPanel — keybindings (both risk levels)", () => {
  test("y triggers run for medium risk", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("y");
    expect(result).toBe("run");
  });

  test("y triggers run for high risk", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={(c) => (result = c)} />,
    );
    stdin.write("y");
    expect(result).toBe("run");
  });

  test("n triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("n");
    expect(result).toBe("cancel");
  });

  test("q triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("q");
    expect(result).toBe("cancel");
  });

  test("Esc triggers cancel", async () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\x1b");
    // Ink's input parser uses a timeout to distinguish bare Esc from escape sequences
    await new Promise((r) => setTimeout(r, 100));
    expect(result).toBe("cancel");
  });

  test("d/e/f/c are no-ops (ignored in phase 1)", () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("d");
    stdin.write("e");
    stdin.write("f");
    stdin.write("c");
    expect(result).toBeUndefined();
    expect(lastFrame()).toContain("rm file");
  });

  test("ignores unrecognized keys", () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("x");
    stdin.write("a");
    expect(result).toBeUndefined();
    expect(lastFrame()).toContain("rm file");
  });

  test("Enter activates selected action (default: No = cancel)", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\r");
    expect(result).toBe("cancel");
  });

  test("arrow right then Enter activates Yes = run", async () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    // Move right to "Yes" — wait for React re-render before pressing Enter
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    expect(result).toBe("run");
  });
});
