import { describe, expect, test } from "bun:test";
import { assembleCommandPrompt, type QueryContext } from "../src/llm/context.ts";
import { FEW_SHOT_DEMOS, SCHEMA_TEXT, SYSTEM_PROMPT } from "../src/prompt.optimized.ts";

function makeContext(overrides?: Partial<QueryContext>): QueryContext {
  return {
    prompt: "list files",
    cwd: "/home/user",
    memory: {},
    ...overrides,
  };
}

describe("assembleCommandPrompt", () => {
  test("system prompt contains SYSTEM_PROMPT and schema text", () => {
    const result = assembleCommandPrompt(makeContext());
    expect(result.system).toContain(SYSTEM_PROMPT);
    if (SCHEMA_TEXT) {
      expect(result.system).toContain(SCHEMA_TEXT);
    }
  });

  test("few-shot demos become user/assistant turn pairs", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_DEMOS.length === 0) return;
    // Each demo = one user + one assistant message
    const demoMessages = result.messages.slice(0, FEW_SHOT_DEMOS.length * 2);
    for (let i = 0; i < FEW_SHOT_DEMOS.length; i++) {
      expect(demoMessages[i * 2]).toEqual({
        role: "user",
        content: FEW_SHOT_DEMOS[i].input,
      });
      expect(demoMessages[i * 2 + 1]).toEqual({
        role: "assistant",
        content: FEW_SHOT_DEMOS[i].output,
      });
    }
  });

  test("separator message follows few-shot demos", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_DEMOS.length === 0) return;
    const separatorIndex = FEW_SHOT_DEMOS.length * 2;
    expect(result.messages[separatorIndex]).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });

  test("final user message contains cwd and prompt", () => {
    const result = assembleCommandPrompt(makeContext({ cwd: "/tmp/test", prompt: "find stuff" }));
    const last = result.messages[result.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("/tmp/test");
    expect(last.content).toContain("find stuff");
  });

  test("final user message includes memory facts", () => {
    const ctx = makeContext({
      memory: { "/": [{ fact: "OS is macOS" }, { fact: "shell is zsh" }] },
    });
    const result = assembleCommandPrompt(ctx);
    const last = result.messages[result.messages.length - 1];
    expect(last.content).toContain("OS is macOS");
    expect(last.content).toContain("shell is zsh");
  });

  test("final user message omits known facts section when memory is empty", () => {
    const result = assembleCommandPrompt(makeContext({ memory: {} }));
    const last = result.messages[result.messages.length - 1];
    expect(last.content).not.toContain("Known facts");
  });

  test("no separator when there are no few-shot demos", () => {
    // Even if the current optimized prompt has demos, test the logic:
    // We can't easily mock the import, but we can verify structure.
    // If demos exist, separator is at index demos*2. If not, first message is the user message.
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_DEMOS.length === 0) {
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
    }
  });

  test("messages array length is correct", () => {
    const result = assembleCommandPrompt(makeContext());
    const demoCount = FEW_SHOT_DEMOS.length;
    const expected =
      demoCount > 0
        ? demoCount * 2 + 1 /* separator */ + 1 /* final user */
        : 1; /* just final user */
    expect(result.messages.length).toBe(expected);
  });
});
