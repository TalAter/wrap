import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import {
  createFollowupHandler,
  type LoopState,
  REFUSED_PROBE_INSTRUCTION,
  stripStaleInstructions,
} from "../src/core/query.ts";
import type { ConversationMessage, PromptInput, Provider } from "../src/llm/types.ts";
import { createLogEntry, type LogEntry, type Round } from "../src/logging/entry.ts";
import promptConstants from "../src/prompt.constants.json";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

function makeProvider(responses: CommandResponse[]): Provider {
  let calls = 0;
  return {
    runPrompt: async () => {
      const r = responses[calls];
      calls += 1;
      if (!r) throw new Error(`unexpected call ${calls}`);
      return r;
    },
  };
}

function makeInput(extraMessages: ConversationMessage[] = []): PromptInput {
  return {
    system: "system",
    messages: [{ role: "user", content: "test" }, ...extraMessages],
  };
}

function makeEntry(): LogEntry {
  return createLogEntry({
    prompt: "test",
    cwd: "/tmp",
    provider: { type: "test" },
    promptHash: "h",
  });
}

function makeOptions() {
  return {
    cwd: "/tmp",
    wrapHome: "/tmp",
    maxRounds: 5,
    maxProbeOutput: 10000,
    pipedInput: undefined,
  };
}

let stderr: MockStderr;

beforeEach(() => {
  stderr = mockStderr();
});

afterEach(() => {
  stderr.restore();
});

describe("stripStaleInstructions", () => {
  test("removes lastRoundInstruction user message", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: promptConstants.lastRoundInstruction },
    ];
    stripStaleInstructions(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("hello");
    expect(messages[1]?.content).toBe("world");
  });

  test("removes refused-probe instruction AND its preceding assistant probe echo", () => {
    // The producer pushes the pair atomically: [assistant probe JSON, user
    // refusal]. Stripping only the user side would leave an orphan assistant
    // turn, producing two consecutive assistant messages once the closure
    // pushes the next currentResponse.
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: '{"type":"probe","content":"rm -rf /"}' },
      { role: "user", content: REFUSED_PROBE_INSTRUCTION },
    ];
    stripStaleInstructions(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hello");
  });

  test("removes both stale instructions in one pass", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: '{"type":"probe"}' },
      { role: "user", content: REFUSED_PROBE_INSTRUCTION },
      { role: "assistant", content: "ack" },
      { role: "user", content: promptConstants.lastRoundInstruction },
    ];
    stripStaleInstructions(messages);
    expect(messages.map((m) => m.content)).toEqual(["hello", "ack"]);
  });

  test("does not remove assistant message when refused-probe is the first message", () => {
    // Defensive: if a refused-probe instruction appears with no preceding
    // assistant (impossible from the producer but worth pinning), we just
    // strip the user message without crashing.
    const messages: ConversationMessage[] = [
      { role: "user", content: REFUSED_PROBE_INSTRUCTION },
      { role: "assistant", content: "after" },
    ];
    stripStaleInstructions(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("after");
  });

  test("no-op when no stale instructions present", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "follow-up" },
    ];
    const before = messages.slice();
    stripStaleInstructions(messages);
    expect(messages).toEqual(before);
  });

  test("does not remove an assistant message that happens to match the constant", () => {
    // Defensive: only user messages are stripped — an assistant message with
    // matching content (unlikely but possible) must be left alone.
    const messages: ConversationMessage[] = [
      { role: "assistant", content: promptConstants.lastRoundInstruction },
    ];
    stripStaleInstructions(messages);
    expect(messages).toHaveLength(1);
  });
});

describe("createFollowupHandler", () => {
  test("returns command FollowupResult and updates internal state for next call", async () => {
    const provider = makeProvider([
      { type: "command", content: "rm -i a", risk_level: "low" } as CommandResponse,
      { type: "command", content: "rm -v a", risk_level: "medium" } as CommandResponse,
    ]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const initialRound: Round = {
      parsed: { type: "command", content: "rm a", risk_level: "high" } as CommandResponse,
    };
    const refs = {
      response: { type: "command", content: "rm a", risk_level: "high" } as CommandResponse,
      round: initialRound as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      refs,
    });

    const r1 = await handler("be safer", new AbortController().signal);
    expect(r1.type).toBe("command");
    if (r1.type === "command") {
      expect(r1.command).toBe("rm -i a");
      expect(r1.riskLevel).toBe("low");
    }
    // refs.round was updated to the new command round (unlogged)
    expect(refs.response.content).toBe("rm -i a");
    expect(refs.round?.parsed?.content).toBe("rm -i a");

    // The previous (initial) round was logged when the closure started.
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0]?.parsed?.content).toBe("rm a");

    // Chained call: previous (now refs.round = "rm -i a") gets logged.
    const r2 = await handler("verbose please", new AbortController().signal);
    expect(r2.type).toBe("command");
    if (r2.type === "command") expect(r2.command).toBe("rm -v a");
    expect(entry.rounds).toHaveLength(2);
    expect(entry.rounds[1]?.parsed?.content).toBe("rm -i a");
  });

  test("returns answer FollowupResult and clears refs.round", async () => {
    const provider = makeProvider([
      { type: "answer", content: "the answer", risk_level: "low" } as CommandResponse,
    ]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const refs = {
      response: { type: "command", content: "rm a", risk_level: "high" } as CommandResponse,
      round: { parsed: { type: "command", content: "rm a", risk_level: "high" } } as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      refs,
    });

    const r = await handler("just tell me", new AbortController().signal);
    expect(r.type).toBe("answer");
    if (r.type === "answer") expect(r.content).toBe("the answer");

    // Initial round was logged (superseded by the answer).
    expect(entry.rounds.length).toBeGreaterThanOrEqual(1);
    expect(entry.rounds[0]?.parsed?.content).toBe("rm a");
    // refs.round is cleared since no new command round needs logging by caller.
    expect(refs.round).toBeNull();
  });

  test("returns exhausted FollowupResult when budget runs out", async () => {
    // Probe forever — budget exhausts.
    const probe = { type: "probe", content: "true", risk_level: "low" } as CommandResponse;
    const provider = makeProvider([probe, probe, probe, probe, probe]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const refs = {
      response: { type: "command", content: "x", risk_level: "high" } as CommandResponse,
      round: { parsed: { type: "command", content: "x", risk_level: "high" } } as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: { ...makeOptions(), maxRounds: 3 },
      refs,
    });

    const r = await handler("hmm", new AbortController().signal);
    expect(r.type).toBe("exhausted");
    expect(refs.round).toBeNull();
  });

  test("aborts mid-flight: drops command result, logs the orphan round, leaves refs untouched", async () => {
    // Race: the loop completes a real command BUT the user pressed Esc just
    // before the result resolved. The closure must NOT mutate refs (the
    // dialog will drop the result anyway, and a polluted refs would corrupt
    // the user's next action). The orphan round is still logged for the
    // audit trail since the LLM did real work.
    const controller = new AbortController();
    const pending: { resolve?: (r: CommandResponse) => void } = {};
    const provider: Provider = {
      runPrompt: () =>
        new Promise<unknown>((res) => {
          pending.resolve = (r) => res(r);
        }),
    };
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const originalResponse = {
      type: "command",
      content: "rm a",
      risk_level: "high",
    } as CommandResponse;
    const originalRound = { parsed: originalResponse } as Round;
    const refs = {
      response: originalResponse,
      round: originalRound as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      refs,
    });

    // Kick off the call.
    const handlerPromise = handler("safer", controller.signal);
    // Wait a tick so the inner runPrompt is awaiting our resolver.
    await new Promise((r) => setTimeout(r, 10));
    // User presses Esc — abort the signal *before* the loop's next iteration.
    controller.abort();
    // Loop returns a "successful" command — but the signal is now aborted.
    pending.resolve?.({
      type: "command",
      content: "rm -i a",
      risk_level: "low",
    } as CommandResponse);
    const r = await handlerPromise;

    expect(r.type).toBe("aborted");
    // refs is NOT mutated — original command/risk preserved for the user.
    expect(refs.response).toBe(originalResponse);
    expect(refs.response.content).toBe("rm a");
    // refs.round was nulled at the start of the call (and never replaced).
    expect(refs.round).toBeNull();
    // The orphan round is logged (for audit), AND the original round is
    // logged (closure logged it before re-entering the loop).
    expect(entry.rounds).toHaveLength(2);
    expect(entry.rounds[0]?.parsed?.content).toBe("rm a");
    expect(entry.rounds[1]?.parsed?.content).toBe("rm -i a");
  });

  test("returns aborted FollowupResult when signal is aborted before any LLM call", async () => {
    const provider = makeProvider([]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const refs = {
      response: { type: "command", content: "x", risk_level: "high" } as CommandResponse,
      round: { parsed: { type: "command", content: "x", risk_level: "high" } } as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      refs,
    });

    const controller = new AbortController();
    controller.abort();
    const r = await handler("nope", controller.signal);
    expect(r.type).toBe("aborted");
    // refs.round is cleared (the previous round was logged).
    expect(refs.round).toBeNull();
    expect(entry.rounds).toHaveLength(1);
  });

  test("strips stale instructions before pushing follow-up turn", async () => {
    // Simulate a previous loop call that left lastRoundInstruction in messages.
    const input = makeInput([{ role: "user", content: promptConstants.lastRoundInstruction }]);
    const provider = makeProvider([
      { type: "command", content: "echo done", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const refs = {
      response: { type: "command", content: "x", risk_level: "high" } as CommandResponse,
      round: { parsed: { type: "command", content: "x", risk_level: "high" } } as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      refs,
    });

    await handler("refine", new AbortController().signal);

    // The stale lastRoundInstruction must have been stripped.
    const stale = input.messages.some((m) => m.content === promptConstants.lastRoundInstruction);
    expect(stale).toBe(false);
    // The follow-up text was pushed.
    const hasFollowup = input.messages.some((m) => m.role === "user" && m.content === "refine");
    expect(hasFollowup).toBe(true);
  });

  test("pushes assistant JSON of currentResponse before follow-up text", async () => {
    const input = makeInput();
    const provider = makeProvider([
      { type: "command", content: "ls", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const currentResponse = {
      type: "command",
      content: "rm a",
      risk_level: "high",
    } as CommandResponse;
    const refs = {
      response: currentResponse,
      round: { parsed: currentResponse } as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      refs,
    });

    await handler("safer please", new AbortController().signal);

    // Find the assistant message with the original command JSON.
    const idx = input.messages.findIndex(
      (m) => m.role === "assistant" && m.content.includes("rm a"),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    // The follow-up user text immediately follows.
    expect(input.messages[idx + 1]?.role).toBe("user");
    expect(input.messages[idx + 1]?.content).toBe("safer please");
  });

  test("resets budgetRemaining to maxRounds before re-entering the loop", async () => {
    const provider = makeProvider([
      { type: "command", content: "echo ok", risk_level: "low" } as CommandResponse,
    ]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 5 };
    const entry = makeEntry();
    const refs = {
      response: { type: "command", content: "x", risk_level: "high" } as CommandResponse,
      round: { parsed: { type: "command", content: "x", risk_level: "high" } } as Round | null,
    };
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: { ...makeOptions(), maxRounds: 5 },
      refs,
    });

    await handler("hmm", new AbortController().signal);

    // Budget was reset to 5, then decremented once for the single round = 4.
    expect(state.budgetRemaining).toBe(4);
    // Round counter is monotonic — incremented from 5 to 6.
    expect(state.roundNum).toBe(6);
  });
});
