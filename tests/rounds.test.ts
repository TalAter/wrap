import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { type LoopState, runRoundsUntilFinal } from "../src/core/query.ts";
import type { Provider } from "../src/llm/types.ts";
import { makeEntry, makeInput, makeOptions, makeProvider } from "./helpers/loop-fixtures.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

let stderr: MockStderr;

beforeEach(() => {
  stderr = mockStderr();
});

afterEach(() => {
  stderr.restore();
});

describe("runRoundsUntilFinal", () => {
  test("returns command result and logs the round eagerly", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "ls -la", risk_level: "medium" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const entry = makeEntry();
    const result = await runRoundsUntilFinal(provider, makeInput(), state, entry, makeOptions());
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.response.content).toBe("ls -la");
      expect(result.response.risk_level).toBe("medium");
      // The returned round IS the same object held in entry.rounds — the
      // caller mutates exec_ms/execution on it after running, and the in-
      // place mutation is what shows up at log-flush time.
      expect(entry.rounds[0]).toBe(result.round);
    }
    expect(state.roundNum).toBe(1);
    expect(state.budgetRemaining).toBe(4);
    expect(entry.rounds.length).toBe(1);
  });

  test("returns answer result when LLM responds with answer", async () => {
    const { provider } = makeProvider([
      { type: "answer", content: "the answer", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const entry = makeEntry();
    const result = await runRoundsUntilFinal(provider, makeInput(), state, entry, makeOptions());
    expect(result.type).toBe("answer");
    if (result.type === "answer") {
      expect(result.content).toBe("the answer");
    }
    expect(entry.rounds.length).toBe(1);
  });

  test("returns exhausted when budget runs out without final response", async () => {
    // All probes - never produces a command/answer; runs probes until budget exhausted.
    const probe: CommandResponse = {
      type: "probe",
      content: "true",
      risk_level: "low",
    } as CommandResponse;
    const { provider } = makeProvider([probe, probe, probe]);
    const state: LoopState = { budgetRemaining: 2, roundNum: 0 };
    const entry = makeEntry();
    const result = await runRoundsUntilFinal(
      provider,
      makeInput(),
      state,
      entry,
      makeOptions({ maxRounds: 2 }),
    );
    expect(result.type).toBe("exhausted");
    expect(state.budgetRemaining).toBe(0);
    expect(state.roundNum).toBe(2);
  });

  test("loops through probe round, then returns command on second round", async () => {
    const { provider } = makeProvider([
      { type: "probe", content: "true", risk_level: "low" } as CommandResponse,
      { type: "command", content: "rm foo", risk_level: "medium" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const input = makeInput();
    const result = await runRoundsUntilFinal(provider, input, state, makeEntry(), makeOptions());
    expect(result.type).toBe("command");
    expect(state.roundNum).toBe(2);
    // Probe output should have been appended to the conversation.
    expect(input.messages.length).toBeGreaterThan(2);
  });

  test("returns aborted when AbortSignal is already aborted", async () => {
    const { provider } = makeProvider([
      { type: "answer", content: "should not see this", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const controller = new AbortController();
    controller.abort();
    const result = await runRoundsUntilFinal(provider, makeInput(), state, makeEntry(), {
      ...makeOptions(),
      signal: controller.signal,
    });
    expect(result.type).toBe("aborted");
  });

  test("does not increment roundNum when aborted before first iteration", async () => {
    const { provider } = makeProvider([]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const controller = new AbortController();
    controller.abort();
    await runRoundsUntilFinal(provider, makeInput(), state, makeEntry(), {
      ...makeOptions(),
      signal: controller.signal,
    });
    expect(state.roundNum).toBe(0);
  });

  test("preserves roundNum across calls (follow-up scenario)", async () => {
    const { provider: p1 } = makeProvider([
      { type: "command", content: "ls", risk_level: "medium" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const input = makeInput();
    await runRoundsUntilFinal(p1, input, state, makeEntry(), makeOptions());
    expect(state.roundNum).toBe(1);

    // Simulate a follow-up: budget resets, roundNum keeps growing.
    state.budgetRemaining = 5;
    const { provider: p2 } = makeProvider([
      { type: "answer", content: "done", risk_level: "low" } as CommandResponse,
    ]);
    await runRoundsUntilFinal(p2, input, state, makeEntry(), makeOptions());
    expect(state.roundNum).toBe(2);
  });

  test("throws when LLM responds with whitespace-only content", async () => {
    const { provider } = makeProvider([
      { type: "answer", content: "   \n  ", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const entry = makeEntry();
    let thrown: unknown;
    try {
      await runRoundsUntilFinal(provider, makeInput(), state, entry, makeOptions());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("LLM returned an empty response.");
    // The empty round must be logged before throwing so the failure is visible.
    expect(entry.rounds.length).toBe(1);
  });

  test("returns exhausted when probe is returned on the final round", async () => {
    // The last-round instruction should push the LLM to return command/answer,
    // but if it ignores it and returns a probe anyway, the loop must break and
    // return exhausted (not run the probe and loop forever).
    const { provider } = makeProvider([
      { type: "probe", content: "true", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 1, roundNum: 0 };
    const result = await runRoundsUntilFinal(
      provider,
      makeInput(),
      state,
      makeEntry(),
      makeOptions({ maxRounds: 1 }),
    );
    expect(result.type).toBe("exhausted");
    expect(state.roundNum).toBe(1);
  });

  test("appends last-round instruction on the final iteration", async () => {
    const { provider } = makeProvider([
      { type: "probe", content: "true", risk_level: "low" } as CommandResponse,
      { type: "command", content: "echo done", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 2, roundNum: 0 };
    const input = makeInput();
    await runRoundsUntilFinal(provider, input, state, makeEntry(), makeOptions({ maxRounds: 2 }));
    // After the probe round, before the second LLM call, the last-round
    // instruction should be appended. Look for it in the messages.
    const userContents = input.messages.filter((m) => m.role === "user").map((m) => m.content);
    const hasLastRound = userContents.some((c) => c.includes("must"));
    expect(hasLastRound).toBe(true);
  });

  test("rethrows LLM errors and logs the round with provider_error", async () => {
    const provider: Provider = {
      runPrompt: async () => {
        throw new Error("network down");
      },
    };
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const entry = makeEntry();
    let thrown: unknown;
    try {
      await runRoundsUntilFinal(provider, makeInput(), state, entry, makeOptions());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Wrapped with attempted provider/model so users see what was tried;
    // original SDK message is preserved inside.
    expect((thrown as Error).message).toContain("test / test");
    expect((thrown as Error).message).toContain("network down");
    // The errored round must still be in the log so failures are visible.
    expect(entry.rounds.length).toBe(1);
    expect(entry.rounds[0]?.provider_error).toBe("network down");
  });

  test("detects abort fired between rounds (mid-flight)", async () => {
    // First round runs (probe), then we abort, then the next iteration's
    // top-of-loop check should bail out before the second LLM call.
    const controller = new AbortController();
    let calls = 0;
    const provider: Provider = {
      runPrompt: async () => {
        calls += 1;
        if (calls === 1) {
          // Fire abort BEFORE returning so it's set when the next iteration starts.
          controller.abort();
          return { type: "probe", content: "true", risk_level: "low" } as CommandResponse;
        }
        throw new Error("should not reach second call");
      },
    };
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const result = await runRoundsUntilFinal(provider, makeInput(), state, makeEntry(), {
      ...makeOptions(),
      signal: controller.signal,
    });
    expect(result.type).toBe("aborted");
    expect(calls).toBe(1);
    // First round completed, second was aborted before incrementing.
    expect(state.roundNum).toBe(1);
  });
});
