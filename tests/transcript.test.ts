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
  content: "ls -la",
  risk_level: "medium",
} as CommandResponse;

const probeResponse: CommandResponse = {
  type: "probe",
  content: "uname",
  risk_level: "low",
} as CommandResponse;

const answerResponse: CommandResponse = {
  type: "answer",
  content: "the answer",
  risk_level: "low",
} as CommandResponse;

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

  test("user + probe turn renders as user, assistant(JSON), user(captured output)", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "out1", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(probeResponse),
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: `${promptConstants.sectionCapturedOutput}\nout1`,
    });
  });

  test("probe with empty output renders the capturedNoOutput sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("probe with whitespace-only output and exit 0 renders the no-output sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "  \n  ", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("probe output with trailing newline is trimmed in render", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "hi\n", exitCode: 0 },
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

  test("scratchpadRequiredRetry echoes rejected response with _scratchpad intact", () => {
    const rejected: CommandResponse = {
      _scratchpad: null,
      type: "command",
      content: "rm -rf node_modules",
      risk_level: "high",
    } as CommandResponse;
    const transcript: Transcript = [{ kind: "user", text: "nuke deps" }];
    const out = buildPromptInput(transcript, sys, {
      scratchpadRequiredRetry: { rejectedResponse: rejected },
    });
    expect(out.messages).toHaveLength(3);
    // Assistant echo must preserve _scratchpad (even null) so the model
    // sees what it needs to fix — the one exception to the cross-round
    // strip rule.
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(rejected),
    });
    expect(out.messages[1]?.content).toContain("_scratchpad");
    expect(out.messages[2]).toEqual({
      role: "user",
      content: promptConstants.scratchpadRequiredInstruction,
    });
  });

  test("probeRiskRetry directive appends rejected echo + probeRiskInstruction", () => {
    const rejected: CommandResponse = {
      type: "probe",
      content: "rm -rf /",
      risk_level: "high",
    } as CommandResponse;
    const transcript: Transcript = [{ kind: "user", text: "danger" }];
    const out = buildPromptInput(transcript, sys, {
      probeRiskRetry: { rejectedResponse: rejected },
    });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(rejected),
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: promptConstants.probeRiskInstruction,
    });
  });

  test("does not mutate the input transcript", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "out", exitCode: 0 },
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

  test("strips _scratchpad from probe response before echoing as assistant turn", () => {
    const probeWithScratchpad: CommandResponse = {
      _scratchpad: "Need to check shell first.",
      type: "probe",
      content: "echo $SHELL",
      risk_level: "low",
    } as CommandResponse;
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeWithScratchpad, output: "zsh", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    const assistantMsg = out.messages[1];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).not.toContain("_scratchpad");
    expect(assistantMsg?.content).not.toContain("Need to check shell first");
    // Other fields still present
    const parsed = JSON.parse(assistantMsg?.content ?? "{}");
    expect(parsed.content).toBe("echo $SHELL");
    expect(parsed.type).toBe("probe");
  });

  test("strips _scratchpad from candidate_command turn", () => {
    const cmdWithScratchpad: CommandResponse = {
      _scratchpad: "Listing files.",
      type: "command",
      content: "ls",
      risk_level: "low",
    } as CommandResponse;
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "candidate_command", response: cmdWithScratchpad },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[1]?.content).not.toContain("_scratchpad");
  });

  test("strips _scratchpad from answer turn", () => {
    const answerWithScratchpad: CommandResponse = {
      _scratchpad: "Knowledge question.",
      type: "answer",
      content: "42",
      risk_level: "low",
    } as CommandResponse;
    const transcript: Transcript = [
      { kind: "user", text: "meaning of life?" },
      { kind: "answer", response: answerWithScratchpad },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[1]?.content).not.toContain("_scratchpad");
  });

  test("probe output with non-zero exit code includes the exit code", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "boom", exitCode: 2 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toContain("Exit code: 2");
  });
});
