import { describe, expect, test } from "bun:test";
import { assemblePromptScaffold, type QueryContext } from "../src/llm/context.ts";
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

function userText(ctx: QueryContext): string {
  return assemblePromptScaffold(ctx).initialUserText;
}

describe("assemblePromptScaffold", () => {
  test("system prompt contains SYSTEM_PROMPT and schema text", () => {
    const result = assemblePromptScaffold(makeContext());
    expect(result.system).toContain(SYSTEM_PROMPT);
    if (SCHEMA_TEXT) {
      expect(result.system).toContain(SCHEMA_TEXT);
    }
  });

  test("few-shot examples become user/assistant prefix-message pairs", () => {
    const result = assemblePromptScaffold(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) return;
    const prefix = result.prefixMessages.slice(0, FEW_SHOT_EXAMPLES.length * 2);
    for (let i = 0; i < FEW_SHOT_EXAMPLES.length; i++) {
      const example = FEW_SHOT_EXAMPLES[i];
      const userMsg = prefix[i * 2];
      const assistantMsg = prefix[i * 2 + 1];
      if (!example || !userMsg || !assistantMsg)
        throw new Error(`missing example or message at index ${i}`);
      expect(userMsg).toEqual({ role: "user", content: example.input });
      expect(assistantMsg).toEqual({ role: "assistant", content: example.output });
    }
  });

  test("separator message follows few-shot examples", () => {
    const result = assemblePromptScaffold(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) return;
    const separatorIndex = FEW_SHOT_EXAMPLES.length * 2;
    const separator = result.prefixMessages[separatorIndex];
    if (!separator) throw new Error("expected separator message");
    expect(separator).toEqual({
      role: "user",
      content: "Now handle the following request.",
    });
  });

  test("initial user text contains cwd and prompt", () => {
    const result = assemblePromptScaffold(makeContext({ cwd: "/tmp/test", prompt: "find stuff" }));
    expect(result.initialUserText).toContain("/tmp/test");
    expect(result.initialUserText).toContain("find stuff");
  });

  test("no separator when there are no few-shot examples", () => {
    // (Real prompt has examples; this guards the empty case for completeness.)
    const result = assemblePromptScaffold(makeContext());
    if (FEW_SHOT_EXAMPLES.length === 0) {
      expect(result.prefixMessages.length).toBe(0);
    }
  });

  test("prefix messages length is correct (2 per example + separator)", () => {
    const result = assemblePromptScaffold(makeContext());
    const exampleCount = FEW_SHOT_EXAMPLES.length;
    const expected = exampleCount > 0 ? exampleCount * 2 + 1 : 0;
    expect(result.prefixMessages.length).toBe(expected);
  });
});

describe("scoped memory in prompt", () => {
  test("global facts always included", () => {
    const text = userText(
      makeContext({
        cwd: "/some/random/dir",
        memory: { "/": [{ fact: "macOS arm64" }] },
      }),
    );
    expect(text).toContain("macOS arm64");
  });

  test("global scope uses '## System facts' header", () => {
    const text = userText(
      makeContext({
        memory: { "/": [{ fact: "macOS" }] },
      }),
    );
    expect(text).toContain("## System facts");
    expect(text).not.toContain("## Facts about /");
  });

  test("directory scope uses '## Facts about {path}' header", () => {
    const text = userText(
      makeContext({
        cwd: "/Users/tal/project",
        memory: {
          "/": [{ fact: "macOS" }],
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(text).toContain("## Facts about /Users/tal/project");
    expect(text).toContain("Uses bun");
  });

  test("subdirectory CWD matches parent scope", () => {
    const text = userText(
      makeContext({
        cwd: "/Users/tal/project/packages/api",
        memory: {
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(text).toContain("Uses bun");
  });

  test("unrelated directory scope excluded", () => {
    const text = userText(
      makeContext({
        cwd: "/Users/tal/other",
        memory: {
          "/": [{ fact: "macOS" }],
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(text).toContain("macOS");
    expect(text).not.toContain("Uses bun");
    expect(text).not.toContain("Facts about /Users/tal/project");
  });

  test("sibling directory with shared prefix excluded", () => {
    const text = userText(
      makeContext({
        cwd: "/monorepo-tools",
        memory: {
          "/monorepo": [{ fact: "monorepo fact" }],
        },
      }),
    );
    expect(text).not.toContain("monorepo fact");
  });

  test("sections ordered global then specific (by key order)", () => {
    const text = userText(
      makeContext({
        cwd: "/Users/tal/project/packages/api",
        memory: {
          "/": [{ fact: "global" }],
          "/Users/tal/project": [{ fact: "project" }],
          "/Users/tal/project/packages/api": [{ fact: "api" }],
        },
      }),
    );
    const globalIdx = text.indexOf("## System facts");
    const projectIdx = text.indexOf("## Facts about /Users/tal/project\n");
    const apiIdx = text.indexOf("## Facts about /Users/tal/project/packages/api");
    expect(globalIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(apiIdx);
  });

  test("facts within scope preserve insertion order", () => {
    const text = userText(
      makeContext({
        memory: { "/": [{ fact: "first" }, { fact: "second" }, { fact: "third" }] },
      }),
    );
    const firstIdx = text.indexOf("first");
    const secondIdx = text.indexOf("second");
    const thirdIdx = text.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  test("omits entire facts block when no facts match", () => {
    const text = userText(makeContext({ memory: {} }));
    expect(text).not.toContain("System facts");
    expect(text).not.toContain("Facts about");
    expect(text).not.toContain("Known facts");
  });

  test("omits section for scope with no facts after filtering", () => {
    const text = userText(
      makeContext({
        cwd: "/Users/tal/other",
        memory: {
          "/Users/tal/project": [{ fact: "irrelevant" }],
        },
      }),
    );
    expect(text).not.toContain("Facts about");
    expect(text).not.toContain("irrelevant");
  });

  test("recency instruction appears in system prompt", () => {
    const result = assemblePromptScaffold(makeContext());
    expect(result.system).toContain("later (more recent) fact");
  });

  test("tools scope instruction appears in system prompt", () => {
    const result = assemblePromptScaffold(makeContext());
    expect(result.system).toContain("not exhaustive");
  });

  test("voice instructions appear in system prompt", () => {
    const result = assemblePromptScaffold(makeContext());
    expect(result.system).toContain("dry wit");
  });

  test("piped input instruction in system prompt when pipedInput present", () => {
    const result = assemblePromptScaffold(makeContext({ pipedInput: "some data" }));
    expect(result.system).toContain("Piped input serves as");
  });

  test("no piped input instruction in system prompt when no pipedInput", () => {
    const result = assemblePromptScaffold(makeContext());
    expect(result.system).not.toContain("Piped input serves as");
  });
});

describe("tools output in prompt", () => {
  test("includes detected tools section when available tools provided", () => {
    const text = userText(
      makeContext({ tools: { available: ["/usr/bin/git"], unavailable: ["docker"] } }),
    );
    expect(text).toContain("## Detected tools");
    expect(text).toContain("/usr/bin/git");
  });

  test("includes unavailable tools section", () => {
    const text = userText(
      makeContext({ tools: { available: [], unavailable: ["docker", "kubectl"] } }),
    );
    expect(text).toContain("## Unavailable tools");
    expect(text).toContain("docker, kubectl");
  });

  test("omits tools sections when no tools provided", () => {
    const text = userText(makeContext());
    expect(text).not.toContain("Detected tools");
    expect(text).not.toContain("Unavailable tools");
  });

  test("tools section appears after memory facts and before cwd", () => {
    const text = userText(
      makeContext({
        memory: { "/": [{ fact: "macOS" }] },
        tools: { available: ["/usr/bin/git"], unavailable: [] },
      }),
    );
    const factsIdx = text.indexOf("## System facts");
    const toolsIdx = text.indexOf("## Detected tools");
    const cwdIdx = text.indexOf("Working directory");
    expect(factsIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(cwdIdx);
  });
});

describe("piped input in prompt", () => {
  test("pipedInput shows up in initial user text", () => {
    const text = userText(makeContext({ pipedInput: "error log content here" }));
    expect(text).toContain("## Piped input");
    expect(text).toContain("error log content here");
  });

  test("pipedInput appears before memory facts", () => {
    const text = userText(
      makeContext({
        pipedInput: "log data",
        memory: { "/": [{ fact: "macOS" }] },
      }),
    );
    const pipedIdx = text.indexOf("## Piped input");
    const factsIdx = text.indexOf("## System facts");
    expect(pipedIdx).toBeLessThan(factsIdx);
  });

  test("user request section omitted when prompt is empty", () => {
    const text = userText(makeContext({ prompt: "", pipedInput: "piped content" }));
    expect(text).not.toContain("## User's request");
    expect(text).toContain("## Piped input");
    expect(text).toContain("piped content");
  });

  test("user request section present when prompt is non-empty with piped input", () => {
    const text = userText(makeContext({ prompt: "explain this", pipedInput: "error log" }));
    expect(text).toContain("## User's request\nexplain this");
    expect(text).toContain("## Piped input");
  });
});

describe("piped-mode prompt", () => {
  test("piped: true appends piped-mode instruction", () => {
    const text = userText(makeContext({ piped: true }));
    expect(text).toContain("stdout is being piped");
    expect(text).toContain("bare value");
  });

  test("piped: false does not include piped-mode instruction", () => {
    const text = userText(makeContext({ piped: false }));
    expect(text).not.toContain("stdout is being piped");
  });

  test("piped defaults to false (no piped-mode instruction)", () => {
    const text = userText(makeContext());
    expect(text).not.toContain("stdout is being piped");
  });

  test("piped instruction appears after tools and before cwd", () => {
    const text = userText(
      makeContext({
        tools: { available: ["/usr/bin/git"], unavailable: [] },
        piped: true,
      }),
    );
    const toolsIdx = text.indexOf("## Detected tools");
    const pipedIdx = text.indexOf("stdout is being piped");
    const cwdIdx = text.indexOf("Working directory");
    expect(toolsIdx).toBeLessThan(pipedIdx);
    expect(pipedIdx).toBeLessThan(cwdIdx);
  });
});
