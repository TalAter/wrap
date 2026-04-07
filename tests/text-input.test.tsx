import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { TextInput } from "../src/tui/text-input.tsx";

describe("TextInput — editable", () => {
  test("renders the value", () => {
    const { lastFrame } = render(
      <TextInput value="hello" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("hello");
  });

  test("calls onSubmit on Enter", async () => {
    let submitted: string | undefined;
    const { stdin } = render(
      <TextInput
        value="abc"
        onChange={() => {}}
        onSubmit={(v) => {
          submitted = v;
        }}
      />,
    );
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toBe("abc");
  });

  test("calls onChange when typing", async () => {
    let captured: string | undefined;
    const { stdin } = render(
      <TextInput
        value="ab"
        onChange={(v) => {
          captured = v;
        }}
        onSubmit={() => {}}
      />,
    );
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBe("abc");
  });

  test("renders placeholder when value is empty", () => {
    const { lastFrame } = render(
      <TextInput value="" placeholder="actually..." onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("actually...");
  });

  test("does not render placeholder when value is non-empty", () => {
    const { lastFrame } = render(
      <TextInput value="hi" placeholder="actually..." onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("actually...");
  });

  test("does not handle Esc (parent owns it)", async () => {
    let changed = false;
    const { stdin } = render(
      <TextInput
        value="abc"
        onChange={() => {
          changed = true;
        }}
        onSubmit={() => {}}
      />,
    );
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(changed).toBe(false);
  });
});

describe("TextInput — readOnly", () => {
  test("renders the value", () => {
    const { lastFrame } = render(<TextInput value="frozen text" readOnly />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("frozen text");
  });

  test("does not consume input", async () => {
    // readOnly callers don't supply onChange/onSubmit. Verify typing doesn't crash
    // and the rendered output never shows the typed character.
    const { stdin, lastFrame } = render(<TextInput value="abc" readOnly />);
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 30));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("X");
    expect(stripAnsi(lastFrame() ?? "")).toContain("abc");
  });

  test("empty value still occupies a row", () => {
    // The dark-background strip must not collapse to height 0 when value is
    // empty — otherwise the future processing-followup state would lose
    // visual parity with composing-followup if it briefly had no text.
    const { lastFrame } = render(
      <Box flexDirection="column">
        <Text>top</Text>
        <TextInput value="" readOnly />
        <Text>bottom</Text>
      </Box>,
    );
    // Row count: 3 (top, input row, bottom) — collapsed input would give 2.
    expect(lastFrame()?.split("\n").length).toBe(3);
  });
});
