import { describe, expect, test } from "bun:test";
import { assembleCommandPrompt, type QueryContext } from "../src/llm/context.ts";
import promptOptimized from "../src/prompt.optimized.json";

const SYSTEM_PROMPT = promptOptimized.instruction;
const SCHEMA_TEXT = promptOptimized.schemaText;
const FEW_SHOT_EXAMPLES: readonly { input: string; output: string }[] =
  promptOptimized.fewShotExamples;

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
  const last = result.messages[result.messages.length - 1];
  if (!last) throw new Error("expected at least one message");
  return last.content;
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
      const example = FEW_SHOT_EXAMPLES[i];
      const userMsg = exampleMessages[i * 2];
      const assistantMsg = exampleMessages[i * 2 + 1];
      if (!example || !userMsg || !assistantMsg)
        throw new Error(`missing example or message at index ${i}`);
      expect(userMsg).toEqual({ role: "user", content: example.input });
      expect(assistantMsg).toEqual({ role: "assistant", content: example.output });
    }
  });

  test("separator message follows few-shot examples", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) return;
    const separatorIndex = FEW_SHOT_EXAMPLES.length * 2;
    const separator = result.messages[separatorIndex];
    if (!separator) throw new Error("expected separator message");
    expect(separator).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });

  test("final user message contains cwd and prompt", () => {
    const result = assembleCommandPrompt(makeContext({ cwd: "/tmp/test", prompt: "find stuff" }));
    const last = result.messages[result.messages.length - 1];
    if (!last) throw new Error("expected at least one message");
    expect(last.role).toBe("user");
    expect(last.content).toContain("/tmp/test");
    expect(last.content).toContain("find stuff");
  });

  test("no separator when there are no few-shot examples", () => {
    const result = assembleCommandPrompt(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) {
      expect(result.messages.length).toBe(1);
      const first = result.messages[0];
      if (!first) throw new Error("expected at least one message");
      expect(first.role).toBe("user");
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

  test("tools scope instruction appears in system prompt", () => {
    const result = assembleCommandPrompt(makeContext());
    expect(result.system).toContain("not exhaustive");
  });

  test("voice instructions appear in system prompt", () => {
    const result = assembleCommandPrompt(makeContext());
    expect(result.system).toContain("dry wit");
  });
});

describe("tools output in prompt", () => {
  test("includes detected tools section when available tools provided", () => {
    const content = lastMessage(
      makeContext({ tools: { available: ["/usr/bin/git"], unavailable: ["docker"] } }),
    );
    expect(content).toContain("## Detected tools");
    expect(content).toContain("/usr/bin/git");
  });

  test("includes unavailable tools section", () => {
    const content = lastMessage(
      makeContext({ tools: { available: [], unavailable: ["docker", "kubectl"] } }),
    );
    expect(content).toContain("## Unavailable tools");
    expect(content).toContain("docker, kubectl");
  });

  test("omits tools sections when no tools provided", () => {
    const content = lastMessage(makeContext());
    expect(content).not.toContain("Detected tools");
    expect(content).not.toContain("Unavailable tools");
  });

  test("tools section appears after memory facts and before cwd", () => {
    const content = lastMessage(
      makeContext({
        memory: { "/": [{ fact: "macOS" }] },
        tools: { available: ["/usr/bin/git"], unavailable: [] },
      }),
    );
    const factsIdx = content.indexOf("## System facts");
    const toolsIdx = content.indexOf("## Detected tools");
    const cwdIdx = content.indexOf("Working directory");
    expect(factsIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(cwdIdx);
  });
});

describe("piped input in prompt", () => {
  test("pipedInput shows up in final user message", () => {
    const content = lastMessage(makeContext({ pipedInput: "error log content here" }));
    expect(content).toContain("## Piped input");
    expect(content).toContain("error log content here");
  });

  test("pipedInput appears before memory facts", () => {
    const content = lastMessage(
      makeContext({
        pipedInput: "log data",
        memory: { "/": [{ fact: "macOS" }] },
      }),
    );
    const pipedIdx = content.indexOf("## Piped input");
    const factsIdx = content.indexOf("## System facts");
    expect(pipedIdx).toBeLessThan(factsIdx);
  });

  test("user request section omitted when prompt is empty", () => {
    const content = lastMessage(makeContext({ prompt: "", pipedInput: "piped content" }));
    expect(content).not.toContain("## User's request");
    expect(content).toContain("## Piped input");
    expect(content).toContain("piped content");
  });

  test("user request section present when prompt is non-empty with piped input", () => {
    const content = lastMessage(makeContext({ prompt: "explain this", pipedInput: "error log" }));
    expect(content).toContain("## User's request\nexplain this");
    expect(content).toContain("## Piped input");
  });
});

describe("piped-mode prompt", () => {
  test("piped: true appends piped-mode instruction to user message", () => {
    const content = lastMessage(makeContext({ piped: true }));
    expect(content).toContain("stdout is being piped");
    expect(content).toContain("bare value");
  });

  test("piped: false does not include piped-mode instruction", () => {
    const content = lastMessage(makeContext({ piped: false }));
    expect(content).not.toContain("stdout is being piped");
  });

  test("piped defaults to false (no piped-mode instruction)", () => {
    const content = lastMessage(makeContext());
    expect(content).not.toContain("stdout is being piped");
  });

  test("piped instruction appears after tools and before cwd", () => {
    const content = lastMessage(
      makeContext({
        tools: { available: ["/usr/bin/git"], unavailable: [] },
        piped: true,
      }),
    );
    const toolsIdx = content.indexOf("## Detected tools");
    const pipedIdx = content.indexOf("stdout is being piped");
    const cwdIdx = content.indexOf("Working directory");
    expect(toolsIdx).toBeLessThan(pipedIdx);
    expect(pipedIdx).toBeLessThan(cwdIdx);
  });
});
