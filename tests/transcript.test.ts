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
      content: `${promptConstants.sectionProbeOutput}\nout1`,
    });
  });

  test("probe with empty output renders the probeNoOutput sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionProbeOutput}\n${promptConstants.probeNoOutput}`,
    );
  });

  test("probe with whitespace-only output and exit 0 renders the no-output sentinel", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "  \n  ", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(
      `${promptConstants.sectionProbeOutput}\n${promptConstants.probeNoOutput}`,
    );
  });

  test("probe output with trailing newline is trimmed in render", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "hi\n", exitCode: 0 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toBe(`${promptConstants.sectionProbeOutput}\nhi`);
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

  test("probe output with non-zero exit code includes the exit code", () => {
    const transcript: Transcript = [
      { kind: "user", text: "hi" },
      { kind: "probe", response: probeResponse, output: "boom", exitCode: 2 },
    ];
    const out = buildPromptInput(transcript, sys);
    expect(out.messages[2]?.content).toContain("Exit code: 2");
  });
});
