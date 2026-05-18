import { describe, expect, test } from "bun:test";
import { buildPromptInput, type Transcript } from "../src/core/transcript.ts";
import { assemblePromptScaffold, type QueryContext } from "../src/llm/context.ts";
import promptOptimized from "../src/prompt.optimized.json";

const SYSTEM_PROMPT = promptOptimized.instruction;
const SCHEMA_TEXT = promptOptimized.schemaText;
const FEW_SHOT_EXAMPLES: readonly { input: string; output: string }[] =
  promptOptimized.fewShotExamples;

function makeContext(overrides?: Partial<QueryContext>): QueryContext {
  return {
    cwd: "/home/user",
    memory: {},
    ...overrides,
  };
}

/** Return the formatted contextString (everything but the user-request line). */
function contextText(ctx: QueryContext): string {
  return assemblePromptScaffold(ctx).contextString;
}

/** Render the first user message the LLM sees for `prompt` under context `ctx`. */
function userMessageText(ctx: QueryContext, prompt: string): string {
  const scaffold = assemblePromptScaffold(ctx);
  const transcript: Transcript = [{ kind: "user", text: prompt }];
  const input = buildPromptInput(transcript, scaffold, {
    requestFraming: {
      contextString: scaffold.contextString,
      sectionUserRequest: scaffold.sectionUserRequest,
    },
  });
  const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
  return lastUser?.content ?? "";
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

  test("contextString contains cwd; first user message contains framed prompt", () => {
    const ctx = makeContext({ cwd: "/tmp/test" });
    expect(contextText(ctx)).toContain("/tmp/test");
    expect(userMessageText(ctx, "find stuff")).toContain("find stuff");
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
    const text = contextText(
      makeContext({
        cwd: "/some/random/dir",
        memory: { "/": [{ fact: "macOS arm64" }] },
      }),
    );
    expect(text).toContain("macOS arm64");
  });

  test("global scope uses '## System facts' header", () => {
    const text = contextText(
      makeContext({
        memory: { "/": [{ fact: "macOS" }] },
      }),
    );
    expect(text).toContain("## System facts");
    expect(text).not.toContain("## Facts about /");
  });

  test("directory scope uses '## Facts about {path}' header", () => {
    const text = contextText(
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
    const text = contextText(
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
    const text = contextText(
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
    const text = contextText(
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
    const text = contextText(
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
    const text = contextText(
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
    const text = contextText(makeContext({ memory: {} }));
    expect(text).not.toContain("System facts");
    expect(text).not.toContain("Facts about");
    expect(text).not.toContain("Known facts");
  });

  test("omits section for scope with no facts after filtering", () => {
    const text = contextText(
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

  test("attached input instruction in system prompt when preview present", () => {
    const result = assemblePromptScaffold(
      makeContext({
        attachedInputPath: "/tmp/wrap-scratch-abc/input",
        attachedInputSize: 9,
        attachedInputPreview: "some data",
      }),
    );
    expect(result.system).toContain("$WRAP_TEMP_DIR/input");
    expect(result.system).toContain("file on disk");
  });

  test("no attached input instruction in system prompt when no preview", () => {
    const result = assemblePromptScaffold(makeContext());
    expect(result.system).not.toContain("$WRAP_TEMP_DIR/input");
  });
});

describe("tools output in prompt", () => {
  test("includes detected tools section when available tools provided", () => {
    const text = contextText(
      makeContext({ tools: { available: ["/usr/bin/git"], unavailable: ["docker"] } }),
    );
    expect(text).toContain("## Detected tools");
    expect(text).toContain("/usr/bin/git");
  });

  test("includes unavailable tools section", () => {
    const text = contextText(
      makeContext({ tools: { available: [], unavailable: ["docker", "kubectl"] } }),
    );
    expect(text).toContain("## Unavailable tools");
    expect(text).toContain("docker, kubectl");
  });

  test("omits tools sections when no tools provided", () => {
    const text = contextText(makeContext());
    expect(text).not.toContain("Detected tools");
    expect(text).not.toContain("Unavailable tools");
  });

  test("tools section appears after memory facts and before cwd", () => {
    const text = contextText(
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

describe("attached input in prompt", () => {
  test("preview shows up in contextString", () => {
    const text = contextText(
      makeContext({
        attachedInputPath: "/tmp/wrap-scratch-abc/input",
        attachedInputSize: 22,
        attachedInputPreview: "error log content here",
      }),
    );
    expect(text).toContain("## Attached input");
    expect(text).toContain("error log content here");
  });

  test("attached input appears before memory facts", () => {
    const text = contextText(
      makeContext({
        attachedInputPath: "/tmp/wrap-scratch-abc/input",
        attachedInputSize: 8,
        attachedInputPreview: "log data",
        memory: { "/": [{ fact: "macOS" }] },
      }),
    );
    const pipedIdx = text.indexOf("## Attached input");
    const factsIdx = text.indexOf("## System facts");
    expect(pipedIdx).toBeLessThan(factsIdx);
  });

  test("user request section omitted when prompt is empty (projected)", () => {
    const ctx = makeContext({
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 13,
      attachedInputPreview: "piped content",
    });
    // With an empty prompt the session would NOT push a user turn — but
    // the framing logic itself should still tolerate an empty user.
    const text = userMessageText(ctx, "");
    expect(text).toContain("## Attached input");
    expect(text).toContain("piped content");
    // Header is still applied because the framing wraps any first user turn,
    // even an empty one. The session avoids that by not pushing it in the
    // empty case (interactive bootstrap).
    expect(text).toContain("## User's request");
  });

  test("user request section present when prompt is non-empty with attached input", () => {
    const ctx = makeContext({
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 9,
      attachedInputPreview: "error log",
    });
    const text = userMessageText(ctx, "explain this");
    expect(text).toContain("## User's request\nexplain this");
    expect(text).toContain("## Attached input");
  });
});

describe("piped-mode prompt", () => {
  test("piped: true appends piped-mode instruction", () => {
    const text = contextText(makeContext({ piped: true }));
    expect(text).toContain("stdout is being piped");
    expect(text).toContain("bare value");
  });

  test("piped: false does not include piped-mode instruction", () => {
    const text = contextText(makeContext({ piped: false }));
    expect(text).not.toContain("stdout is being piped");
  });

  test("piped defaults to false (no piped-mode instruction)", () => {
    const text = contextText(makeContext());
    expect(text).not.toContain("stdout is being piped");
  });

  test("piped instruction appears after tools and before cwd", () => {
    const text = contextText(
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
