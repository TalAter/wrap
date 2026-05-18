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
  contextString: "",
  sectionUserRequest: "## User's request",
};

function withPrefix(messages: PromptScaffold["prefixMessages"]): PromptScaffold {
  return {
    system: "system",
    prefixMessages: messages,
    contextString: "",
    sectionUserRequest: "## User's request",
  };
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
  return out;
}

describe("buildPromptInput", () => {
  test("empty transcript yields system + empty messages", () => {
    const out = buildPromptInput([], sys);
    expect(out.system).toBe("system");
    expect(out.messages).toEqual([]);
  });

  test("single user turn renders as user message (bare, no framing)", () => {
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("user + assistant + step turns render in order", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "assistant", response: stepResponse, attempts: [] },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "out1",
        shell: "/bin/sh",
        source: "model",
      },
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

  test("user_override step renders identically to model-source step", () => {
    const confirmedCmd: CommandResponse = {
      type: "command",
      final: false,
      content: "echo git-stash-fake",
      risk_level: "medium",
      plan: "Stash, test, then decide whether to pop.",
    };
    const transcript: Transcript = [
      { kind: "user", text: "test clean" },
      { kind: "assistant", response: confirmedCmd, attempts: [] },
      {
        kind: "step",
        command: "echo git-stash-fake",
        exit_code: 0,
        output: "Saved working directory.",
        shell: "/bin/sh",
        source: "user_override",
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
      { kind: "assistant", response: richResponse, attempts: [] },
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
      { kind: "assistant", response: stepResponse, attempts: [] },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "",
        shell: "/bin/sh",
        source: "model",
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("step with whitespace-only output and exit 0 renders the no-output sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "assistant", response: stepResponse, attempts: [] },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "  \n  ",
        shell: "/bin/sh",
        source: "model",
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("step output with trailing newline is trimmed in render", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "assistant", response: stepResponse, attempts: [] },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "hi\n",
        shell: "/bin/sh",
        source: "model",
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(`${promptConstants.sectionCapturedOutput}\nhi`);
  });

  test("assistant + follow-up user turn renders both", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "assistant", response: cmdResponse, attempts: [] },
      { kind: "user", text: "hmm" },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(project(cmdResponse)),
    });
    expect(out.messages[2]).toEqual({ role: "user", content: "hmm" });
  });

  test("assistant turn for a reply renders as projected JSON", () => {
    const transcript: Transcript = [
      { kind: "user", text: "what" },
      { kind: "assistant", response: answerResponse, attempts: [] },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(project(answerResponse)),
    });
  });

  test("assistant turn with no response (fully-failed round) is skipped", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      {
        kind: "assistant",
        attempts: [{ error: { kind: "provider", message: "rate limit" } }],
      },
      { kind: "user", text: "retry" },
    ];
    const out = buildPromptInput(transcript, sys);
    // Failed assistant turn contributes nothing — projection is [user, user].
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "retry" },
    ]);
  });

  test("requestFraming wraps only the FIRST user turn", () => {
    const transcript: Transcript = [
      { kind: "user", text: "first" },
      { kind: "assistant", response: cmdResponse, attempts: [] },
      { kind: "user", text: "second" },
    ];
    const out = buildPromptInput(transcript, sys, {
      requestFraming: {
        contextString: "ctx-here",
        sectionUserRequest: "## User's request",
      },
    });
    expect(out.messages[0]?.content).toBe("ctx-here\n\n## User's request\nfirst");
    expect(out.messages[2]?.content).toBe("second");
  });

  test("requestFraming with empty contextString omits the leading separator", () => {
    const transcript: Transcript = [{ kind: "user", text: "go" }];
    const out = buildPromptInput(transcript, sys, {
      requestFraming: { contextString: "", sectionUserRequest: "## User's request" },
    });
    expect(out.messages[0]?.content).toBe("## User's request\ngo");
  });

  test("final turn projects as a <wrap-note> user message", () => {
    const transcript: Transcript = [
      {
        kind: "final",
        command: "git push heroku main",
        exit_code: 0,
        shell: "/bin/sh",
        source: "model",
        exec_ms: 10,
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toEqual({
      role: "user",
      content: "<wrap-note>\nprevious command exited 0\n</wrap-note>",
    });
  });

  test("final turn cancelled source includes the proposed command", () => {
    const transcript: Transcript = [
      {
        kind: "final",
        command: "git push heroku main",
        exit_code: null,
        source: "cancelled",
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[0]?.content).toContain("user cancelled the previous command");
    expect(out.messages[0]?.content).toContain("git push heroku main");
  });

  test("cwd_change turn projects as a <wrap-note> user message", () => {
    const transcript: Transcript = [
      { kind: "cwd_change", from: "/Users/tal/proj-a", to: "/Users/tal/proj-b" },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[0]?.content).toContain(
      "cwd changed from /Users/tal/proj-a to /Users/tal/proj-b",
    );
    expect(out.messages[0]?.content).toStartWith("<wrap-note>");
    expect(out.messages[0]?.content).toEndWith("</wrap-note>");
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

  test("scratchpadRequiredRetry directive echoes the rejected response and appends the scratchpad-required instruction", () => {
    const rejected: CommandResponse = {
      type: "command",
      final: true,
      content: "rm -rf /tmp/x",
      risk_level: "high",
    };
    const transcript: Transcript = [{ kind: "user", text: "clean up" }];
    const out = buildPromptInput(transcript, sys, {
      scratchpadRequiredRetry: { rejectedResponse: rejected },
    });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(rejected),
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: promptConstants.scratchpadRequiredInstruction,
    });
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
      { kind: "assistant", response: stepResponse, attempts: [] },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "out",
        shell: "/bin/sh",
        source: "model",
      },
    ];
    const before = transcript.length;
    buildPromptInput(transcript, sys, { isLastRound: true });
    expect(transcript.length).toBe(before);
  });

  test("calling twice with the same args returns equal output", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "assistant", response: cmdResponse, attempts: [] },
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
      { kind: "assistant", response: stepResponse, attempts: [] },
      {
        kind: "step",
        command: "uname",
        exit_code: 2,
        output: "boom",
        shell: "/bin/sh",
        source: "model",
      },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toContain("Exit code: 2");
  });
});
