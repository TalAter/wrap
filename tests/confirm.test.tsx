import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ConfirmPanel } from "../src/tui/confirm.tsx";

describe("ConfirmPanel", () => {
  test("renders command text", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain("rm -rf /");
  });

  test("renders risk level", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="chmod 777 ." riskLevel="medium" onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain("medium");
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

  test("shows keybinding hints", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain("Run");
    expect(lastFrame()).toContain("Cancel");
  });

  test("q triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("q");
    expect(result).toBe("cancel");
  });

  test("Enter triggers run", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\r");
    expect(result).toBe("run");
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
});
