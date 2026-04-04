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
    expect(lastFrame()).toContain("Esc");
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

describe("ConfirmPanel — medium risk keys", () => {
  test("Enter triggers run", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\r");
    expect(result).toBe("run");
  });

  test("q triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm file" riskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("q");
    expect(result).toBe("cancel");
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
});

describe("ConfirmPanel — high risk keys", () => {
  test("y then Enter triggers run", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={(c) => (result = c)} />,
    );
    stdin.write("y");
    expect(result).toBeUndefined();
    stdin.write("\r");
    expect(result).toBe("run");
  });

  test("Enter alone does not run or cancel", () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\r");
    expect(result).toBeUndefined();
    // Should still be showing the panel
    expect(lastFrame()).toContain("rm -rf /");
  });

  test("Enter alone highlights y+Enter hint", async () => {
    const { stdin, lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={() => {}} />,
    );
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain("[y] then [Enter]");
  });

  test("q triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={(c) => (result = c)} />,
    );
    stdin.write("q");
    expect(result).toBe("cancel");
  });

  test("y without Enter does not run", () => {
    let result: string | undefined;
    const { stdin } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={(c) => (result = c)} />,
    );
    stdin.write("y");
    expect(result).toBeUndefined();
  });

  test("shows y+Enter in hints", () => {
    const { lastFrame } = render(
      <ConfirmPanel command="rm -rf /" riskLevel="high" onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain("y+Enter");
  });
});
