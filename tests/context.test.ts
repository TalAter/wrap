import { describe, expect, test } from "bun:test";
import { assembleCommandPrompt, type QueryContext } from "../src/llm/context.ts";
import { FEW_SHOT_EXAMPLES, SCHEMA_TEXT, SYSTEM_PROMPT } from "../src/prompt.optimized.ts";

function makeContext(overrides?: Partial<QueryContext>): QueryContext {
  return {
    prompt: "list files",
    cwd: "/home/user",
    memory: {},
    ...overrides,
  };
}

function lastMessage(ctx: QueryContext) {
  const result = assembleCommandPrompt(ctx);
  return result.messages[result.messages.length - 1].content;
}

describe("assembleCommandPrompt", () => {
  test("system prompt contains SYSTEM_PROMPT and schema text", () => {
    const result = assembleCommandPrompt(makeContext());
    expect(result.system).toContain(SYSTEM_PROMPT);
    if (SCHEMA_TEXT) {
      expect(result.system).toContain(SCHEMA_TEXT);
    }
  });

  test("few-shot examples become user/assistant turn pairs", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) return;
    // Each example = one user + one assistant message
    const exampleMessages = result.messages.slice(0, FEW_SHOT_EXAMPLES.length * 2);
    for (let i = 0; i < FEW_SHOT_EXAMPLES.length; i++) {
      expect(exampleMessages[i * 2]).toEqual({
        role: "user",
        content: FEW_SHOT_EXAMPLES[i].input,
      });
      expect(exampleMessages[i * 2 + 1]).toEqual({
        role: "assistant",
        content: FEW_SHOT_EXAMPLES[i].output,
      });
    }
  });

  test("separator message follows few-shot examples", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) return;
    const separatorIndex = FEW_SHOT_EXAMPLES.length * 2;
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

  test("no separator when there are no few-shot examples", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) {
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
    }
  });

  test("messages array length is correct", () => {
    const result = assembleCommandPrompt(makeContext());
    const exampleCount = FEW_SHOT_EXAMPLES.length;
    const expected =
      exampleCount > 0
        ? exampleCount * 2 + 1 /* separator */ + 1 /* final user */
        : 1; /* just final user */
    expect(result.messages.length).toBe(expected);
  });
});

describe("scoped memory in prompt", () => {
  test("global facts always included", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/some/random/dir",
        memory: { "/": [{ fact: "macOS arm64" }] },
      }),
    );
    expect(content).toContain("macOS arm64");
  });

  test("global scope uses '## System facts' header", () => {
    const content = lastMessage(
      makeContext({
        memory: { "/": [{ fact: "macOS" }] },
      }),
    );
    expect(content).toContain("## System facts");
    expect(content).not.toContain("## Facts about /");
  });

  test("directory scope uses '## Facts about {path}' header", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/Users/tal/project",
        memory: {
          "/": [{ fact: "macOS" }],
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(content).toContain("## Facts about /Users/tal/project");
    expect(content).toContain("Uses bun");
  });

  test("subdirectory CWD matches parent scope", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/Users/tal/project/packages/api",
        memory: {
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(content).toContain("Uses bun");
  });

  test("unrelated directory scope excluded", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/Users/tal/other",
        memory: {
          "/": [{ fact: "macOS" }],
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(content).toContain("macOS");
    expect(content).not.toContain("Uses bun");
    expect(content).not.toContain("Facts about /Users/tal/project");
  });

  test("sibling directory with shared prefix excluded", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/monorepo-tools",
        memory: {
          "/monorepo": [{ fact: "monorepo fact" }],
        },
      }),
    );
    expect(content).not.toContain("monorepo fact");
  });

  test("sections ordered global then specific (by key order)", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/Users/tal/project/packages/api",
        memory: {
          "/": [{ fact: "global" }],
          "/Users/tal/project": [{ fact: "project" }],
          "/Users/tal/project/packages/api": [{ fact: "api" }],
        },
      }),
    );
    const globalIdx = content.indexOf("## System facts");
    const projectIdx = content.indexOf("## Facts about /Users/tal/project\n");
    const apiIdx = content.indexOf("## Facts about /Users/tal/project/packages/api");
    expect(globalIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(apiIdx);
  });

  test("facts within scope preserve insertion order", () => {
    const content = lastMessage(
      makeContext({
        memory: { "/": [{ fact: "first" }, { fact: "second" }, { fact: "third" }] },
      }),
    );
    const firstIdx = content.indexOf("first");
    const secondIdx = content.indexOf("second");
    const thirdIdx = content.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  test("omits entire facts block when no facts match", () => {
    const content = lastMessage(makeContext({ memory: {} }));
    expect(content).not.toContain("System facts");
    expect(content).not.toContain("Facts about");
    expect(content).not.toContain("Known facts");
  });

  test("omits section for scope with no facts after filtering", () => {
    const content = lastMessage(
      makeContext({
        cwd: "/Users/tal/other",
        memory: {
          "/Users/tal/project": [{ fact: "irrelevant" }],
        },
      }),
    );
    expect(content).not.toContain("Facts about");
    expect(content).not.toContain("irrelevant");
  });

  test("recency instruction appears in system prompt", () => {
    const result = assembleCommandPrompt(makeContext());
    expect(result.system).toContain("later (more recent) fact");
  });
});
