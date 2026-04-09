import { describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import {
  type AttemptDirectives,
  buildPromptInput,
  type Transcript,
} from "../src/core/transcript.ts";
import type { PromptScaffold } from "../src/llm/build-prompt.ts";
import promptConstants from "../src/prompt.constants.json";

const sys: PromptScaffold = {
  system: "system",
  prefixMessages: [],
  initialUserText: "",
};

function withPrefix(messages: PromptScaffold["prefixMessages"]): PromptScaffold {
  return { system: "system", prefixMessages: messages, initialUserText: "" };
}

const cmdResponse: CommandResponse = {
  type: "command",
  final: true,
  content: "ls -la",
  risk_level: "medium",
};

const stepResponse: CommandResponse = {
  type: "command",
  final: false,
  content: "uname",
  risk_level: "low",
};

const answerResponse: CommandResponse = {
  type: "reply",
  final: true,
  content: "the answer",
  risk_level: "low",
};

/** Mirror the builder's private `projectResponseForEcho` helper. */
function project(r: CommandResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: r.type,
    final: r.final,
    content: r.content,
    risk_level: r.risk_level,
  };
  if (r.plan != null) out.plan = r.plan;
  if (r.pipe_stdin) out.pipe_stdin = r.pipe_stdin;
  return out;
}

describe("buildPromptInput", () => {
  test("empty transcript yields system + empty messages", () => {
    const out = buildPromptInput([], sys);
    expect(out.system).toBe("system");
    expect(out.messages).toEqual([]);
  });

  test("single user turn renders as user message", () => {
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("user + step turn renders as user, assistant(projected JSON), user(captured output)", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "step", response: stepResponse, output: "out1", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(project(stepResponse)),
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: `${promptConstants.sectionCapturedOutput}\nout1`,
    });
  });

  test("confirmed_step renders identically to step", () => {
    const confirmedCmd: CommandResponse = {
      type: "command",
      final: false,
      content: "git stash",
      risk_level: "medium",
      plan: "Stash, test, then decide whether to pop.",
    };
    const transcript: Transcript = [
      { kind: "user", text: "test clean" },
      {
        kind: "confirmed_step",
        response: confirmedCmd,
        output: "Saved working directory.",
        exitCode: 0,
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(project(confirmedCmd)),
    });
    expect(out.messages[2]?.content).toContain("Saved working directory.");
  });

  test("echo projection strips explanation, memory_updates, watchlist_additions", () => {
    const richResponse: CommandResponse = {
      type: "command",
      final: true,
      content: "ls",
      risk_level: "low",
      explanation: "this is user-facing",
      memory_updates: [{ fact: "uses zsh", scope: "/" }],
      memory_updates_message: "Noted: zsh",
      watchlist_additions: ["eza"],
    };
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "candidate_command", response: richResponse },
    ];
    const out = buildPromptInput(transcript, sys);
    const echoed = out.messages[1]?.content ?? "";
    expect(echoed).not.toContain("this is user-facing");
    expect(echoed).not.toContain("memory_updates");
    expect(echoed).not.toContain("watchlist_additions");
    expect(echoed).toContain('"type":"command"');
    expect(echoed).toContain('"final":true');
  });

  test("step with empty output renders the capturedNoOutput sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "step", response: stepResponse, output: "", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("step with whitespace-only output and exit 0 renders the no-output sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "step", response: stepResponse, output: "  \n  ", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("step output with trailing newline is trimmed in render", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "step", response: stepResponse, output: "hi\n", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(`${promptConstants.sectionCapturedOutput}\nhi`);
  });

  test("candidate_command + follow-up user turn renders both", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "candidate_command", response: cmdResponse },
      { kind: "user", text: "hmm" },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(cmdResponse),
    });
    expect(out.messages[2]).toEqual({ role: "user", content: "hmm" });
  });

  test("answer turn renders as assistant JSON", () => {
    const transcript: Transcript = [
      { kind: "user", text: "what" },
      { kind: "answer", response: answerResponse },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(answerResponse),
    });
  });

  test("liveContext directive appends it as a user turn before lastRoundInstruction", () => {
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const out = buildPromptInput(transcript, sys, {
      liveContext: "## Temporary directory ($WRAP_TEMP_DIR)\n(empty)",
      isLastRound: true,
    });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1]).toEqual({
      role: "user",
      content: "## Temporary directory ($WRAP_TEMP_DIR)\n(empty)",
    });
    expect(out.messages[2]?.content).toBe(promptConstants.lastRoundInstruction);
  });

  test("isLastRound directive appends a final user turn with the constant", () => {
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const directives: AttemptDirectives = { isLastRound: true };
    const out = buildPromptInput(transcript, sys, directives);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toEqual({
      role: "user",
      content: promptConstants.lastRoundInstruction,
    });
  });

  test("does not mutate the input transcript", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "step", response: stepResponse, output: "out", exitCode: 0 },
    ];
    const before = transcript.length;
    buildPromptInput(transcript, sys, { isLastRound: true });
    expect(transcript.length).toBe(before);
  });

  test("calling twice with the same args returns equal output", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "candidate_command", response: cmdResponse },
    ];
    const a = buildPromptInput(transcript, sys);
    const b = buildPromptInput(transcript, sys);
    expect(a).toEqual(b);
  });

  test("scaffold prefixMessages are prepended verbatim before transcript turns", () => {
    const scaffold = withPrefix([
      { role: "user", content: "ex-in" },
      { role: "assistant", content: "ex-out" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "real" }];
    const out = buildPromptInput(transcript, scaffold);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toEqual({ role: "user", content: "ex-in" });
    expect(out.messages[1]).toEqual({ role: "assistant", content: "ex-out" });
    expect(out.messages[2]).toEqual({ role: "user", content: "real" });
  });

  test("step output with non-zero exit code includes the exit code", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "step", response: stepResponse, output: "boom", exitCode: 2 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toContain("Exit code: 2");
  });
});
