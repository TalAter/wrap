import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { ConfirmPanel } from "../src/tui/confirm.tsx";

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
    expect(frame).toContain("⚠ medium");
  });

  test("renders high risk badge", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⚠ high");
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
    const linesWith = withExplanation.lastFrame()?.split("\n").length ?? 0;
    const linesWithout = without.lastFrame()?.split("\n").length ?? 0;
    expect(linesWithout).toBeLessThan(linesWith);
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
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    const interior = lines.slice(1, -1);
    expect(interior.length).toBeGreaterThan(0);
    expect(interior.every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
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

  test("Enter activates selected action (default: Yes = run)", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\r");
    expect(result).toBe("run");
  });

  test("arrow right then Enter activates No = cancel", async () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    // Move right to "No" — wait for React re-render before pressing Enter
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    expect(result).toBe("cancel");
  });
});
