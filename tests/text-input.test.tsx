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

  test("masked mode renders dots instead of characters", () => {
    const { lastFrame } = render(
      <TextInput value="secret" masked onChange={() => {}} onSubmit={() => {}} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).not.toContain("secret");
    expect(text).toContain("•");
  });

  test("masked mode still calls onSubmit with real value", async () => {
    let submitted: string | undefined;
    const { stdin } = render(
      <TextInput
        value="key123"
        masked
        onChange={() => {}}
        onSubmit={(v) => {
          submitted = v;
        }}
      />,
    );
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toBe("key123");
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

describe("TextInput — multiline", () => {
  test("plain Enter submits in multiline mode too", async () => {
    let submitted: string | undefined;
    const { stdin } = render(
      <TextInput
        value="abc"
        multiline
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

  test("empty-buffer Enter is a no-op", async () => {
    let submitted = false;
    const { stdin } = render(
      <TextInput
        value=""
        multiline
        onChange={() => {}}
        onSubmit={() => {
          submitted = true;
        }}
      />,
    );
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toBe(false);
  });

  test("backslash-Enter inserts newline (strips trailing backslash)", async () => {
    let captured: string | undefined;
    const { stdin } = render(
      <TextInput
        value={"foo\\"}
        multiline
        onChange={(v) => {
          captured = v;
        }}
        onSubmit={() => {}}
      />,
    );
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBe("foo\n");
  });

  test("Ctrl+J inserts newline", async () => {
    let captured: string | undefined;
    const { stdin } = render(
      <TextInput
        value="ab"
        multiline
        onChange={(v) => {
          captured = v;
        }}
        onSubmit={() => {}}
      />,
    );
    // Ctrl+J without kitty: raw 0x0A byte; Ink reports input === "\n", key.return === false.
    stdin.write("\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBe("ab\n");
  });

  test("single-line mode: \\n from paste is stripped on insert", async () => {
    // Paste-like burst of characters including a newline. Single-line mode
    // must drop the \n and keep the rest.
    // We simulate by directly triggering the path via a string write.
    // ink-testing-library's stdin.write forwards to Ink's input parser; writing
    // a multi-char string appears as one input event.
    let captured: string | undefined;
    const { stdin } = render(
      <TextInput
        value=""
        onChange={(v) => {
          captured = v;
        }}
        onSubmit={() => {}}
      />,
    );
    stdin.write("hi\nthere");
    await new Promise((r) => setTimeout(r, 30));
    // Single-line: newline stripped, rest inserted.
    expect(captured).toContain("hi");
    expect(captured).toContain("there");
    expect(captured).not.toContain("\n");
  });

  test("editingExternal renders a label and swallows input", async () => {
    let changed = false;
    const { stdin, lastFrame } = render(
      <TextInput
        value="buffer text"
        multiline
        editingExternal
        onChange={() => {
          changed = true;
        }}
        onSubmit={() => {}}
      />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Save and close editor");
    expect(text).not.toContain("buffer text");
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 30));
    expect(changed).toBe(false);
  });

  test("maxRows clips logical lines below the cursor to stay within budget", () => {
    const text = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\n");
    const { lastFrame } = render(
      <TextInput value={text} multiline maxRows={3} onChange={() => {}} onSubmit={() => {}} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    // Cursor initializes at text end → last 3 rows should be visible, first 3 hidden.
    expect(out).toContain("l4");
    expect(out).toContain("l5");
    expect(out).toContain("l6");
    expect(out).not.toContain("l1");
    expect(out).not.toContain("l2");
    expect(out).not.toContain("l3");
  });

  test("multiline value with \\n renders on multiple rows", () => {
    const { lastFrame } = render(
      <TextInput value={"line1\nline2"} multiline onChange={() => {}} onSubmit={() => {}} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    const rows = (lastFrame() ?? "").split("\n").length;
    expect(rows).toBeGreaterThanOrEqual(2);
    expect(text).toContain("line1");
    expect(text).toContain("line2");
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
