import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { RoundError, runRound } from "../src/core/round.ts";
import type { Transcript } from "../src/core/transcript.ts";
import type { PromptScaffold } from "../src/llm/build-prompt.ts";
import type { Provider } from "../src/llm/types.ts";
import promptConstants from "../src/prompt.constants.json";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

const scaffold: PromptScaffold = {
  system: "system",
  prefixMessages: [],
  initialUserText: "",
};

let stderr: MockStderr;

beforeEach(() => {
  stderr = mockStderr();
});

afterEach(() => {
  stderr.restore();
});

function makeTranscript(): Transcript {
  return [{ kind: "user", text: "hi" }];
}

type Captured = {
  calls: number;
  lastInput?: { system: string; messages: { role: string; content: string }[] };
};

function makeProvider(responses: CommandResponse[]): { provider: Provider; captured: Captured } {
  const captured: Captured = { calls: 0 };
  const provider: Provider = {
    runPrompt: async (input) => {
      captured.lastInput = input;
      const r = responses[captured.calls];
      captured.calls += 1;
      if (!r) throw new Error(`unexpected call ${captured.calls}`);
      return r;
    },
  };
  return { provider, captured };
}

describe("runRound", () => {
  test("returns a Round with parsed set on a successful command", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "ls", risk_level: "low" } as CommandResponse,
    ]);
    const round = await runRound(provider, makeTranscript(), scaffold, {
      isLastRound: false,
      model: "test",
      showSpinner: false,
    });
    expect(round.parsed?.type).toBe("command");
    expect(round.parsed?.content).toBe("ls");
    expect(typeof round.llm_ms).toBe("number");
  });

  test("returns a Round with parsed set on a successful answer", async () => {
    const { provider } = makeProvider([
      { type: "answer", content: "hello", risk_level: "low" } as CommandResponse,
    ]);
    const round = await runRound(provider, makeTranscript(), scaffold, {
      isLastRound: false,
      model: "test",
      showSpinner: false,
    });
    expect(round.parsed?.type).toBe("answer");
  });

  test("with isLastRound: true the LLM sees lastRoundInstruction", async () => {
    const { provider, captured } = makeProvider([
      { type: "command", content: "ls", risk_level: "low" } as CommandResponse,
    ]);
    await runRound(provider, makeTranscript(), scaffold, {
      isLastRound: true,
      model: "test",
      showSpinner: false,
    });
    const userMessages = captured.lastInput?.messages.filter((m) => m.role === "user") ?? [];
    const hasLastRound = userMessages.some(
      (m) => m.content === promptConstants.lastRoundInstruction,
    );
    expect(hasLastRound).toBe(true);
  });

  test("does not mutate the transcript", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "ls", risk_level: "low" } as CommandResponse,
    ]);
    const transcript = makeTranscript();
    const before = transcript.length;
    await runRound(provider, transcript, scaffold, {
      isLastRound: false,
      model: "test",
      showSpinner: false,
    });
    expect(transcript.length).toBe(before);
  });

  test("retries once on a non-low probe and uses the second result", async () => {
    const { provider, captured } = makeProvider([
      { type: "probe", content: "rm -rf /", risk_level: "high" } as CommandResponse,
      { type: "probe", content: "ls", risk_level: "low" } as CommandResponse,
    ]);
    const round = await runRound(provider, makeTranscript(), scaffold, {
      isLastRound: false,
      model: "test",
      showSpinner: false,
    });
    expect(captured.calls).toBe(2);
    expect(round.parsed?.type).toBe("probe");
    expect((round.parsed as CommandResponse).content).toBe("ls");
    // The retry call should have included the probeRiskInstruction text.
    const userMessages = captured.lastInput?.messages.filter((m) => m.role === "user") ?? [];
    const hasRetryDirective = userMessages.some(
      (m) => m.content === promptConstants.probeRiskInstruction,
    );
    expect(hasRetryDirective).toBe(true);
  });

  test("throws RoundError on empty content with the partial round attached", async () => {
    const { provider } = makeProvider([
      { type: "answer", content: "   ", risk_level: "low" } as CommandResponse,
    ]);
    let thrown: unknown;
    try {
      await runRound(provider, makeTranscript(), scaffold, {
        isLastRound: false,
        model: "test",
        showSpinner: false,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoundError);
    if (thrown instanceof RoundError) {
      expect(thrown.round.parsed).toBeDefined();
    }
  });

  test("throws RoundError with the model label on LLM call failure", async () => {
    const provider: Provider = {
      runPrompt: async () => {
        throw new Error("network down");
      },
    };
    let thrown: unknown;
    try {
      await runRound(provider, makeTranscript(), scaffold, {
        isLastRound: false,
        model: "test / model",
        showSpinner: false,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoundError);
    if (thrown instanceof RoundError) {
      expect(thrown.message).toContain("test / model");
      expect(thrown.message).toContain("network down");
      expect(thrown.round.provider_error).toBe("network down");
    }
  });

  test("retries once on a structured-output parse failure", async () => {
    let calls = 0;
    const provider: Provider = {
      runPrompt: async () => {
        calls += 1;
        if (calls === 1) {
          // Simulate the AI SDK invalid-JSON branch via the message-string fallback.
          throw new Error("invalid JSON: unexpected token");
        }
        return { type: "command", content: "ls", risk_level: "low" } as CommandResponse;
      },
    };
    const round = await runRound(provider, makeTranscript(), scaffold, {
      isLastRound: false,
      model: "test",
      showSpinner: false,
    });
    expect(calls).toBe(2);
    expect(round.parsed?.content).toBe("ls");
  });
});
