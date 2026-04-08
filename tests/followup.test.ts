import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import {
  createFollowupHandler,
  type LoopState,
  REFUSED_PROBE_INSTRUCTION,
  stripStaleInstructions,
} from "../src/core/query.ts";
import type { ConversationMessage, Provider } from "../src/llm/types.ts";
import type { Round } from "../src/logging/entry.ts";
import promptConstants from "../src/prompt.constants.json";
import { makeEntry, makeInput, makeOptions, makeProvider } from "./helpers/loop-fixtures.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

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
  function makeCurrent(content = "rm a", risk_level: "low" | "medium" | "high" = "high") {
    const response = { type: "command", content, risk_level } as CommandResponse;
    return { response, round: { parsed: response } as Round };
  }

  test("returns command FollowupResult and updates current for chained calls", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "rm -i a", risk_level: "low" } as CommandResponse,
      { type: "command", content: "rm -v a", risk_level: "medium" } as CommandResponse,
    ]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const current = makeCurrent();
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      current,
    });

    const r1 = await handler("be safer", new AbortController().signal);
    expect(r1.type).toBe("command");
    if (r1.type === "command") {
      expect(r1.command).toBe("rm -i a");
      expect(r1.riskLevel).toBe("low");
    }
    // current was updated to the new command + its round (eagerly logged
    // by runRoundsUntilFinal — same object reference).
    expect(current.response.content).toBe("rm -i a");
    expect(current.round.parsed?.content).toBe("rm -i a");
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0]).toBe(current.round);

    // Chained call: a second follow-up produces another command round.
    const r2 = await handler("verbose please", new AbortController().signal);
    expect(r2.type).toBe("command");
    if (r2.type === "command") expect(r2.command).toBe("rm -v a");
    expect(entry.rounds).toHaveLength(2);
    const secondRound = entry.rounds[1];
    expect(secondRound?.parsed?.content).toBe("rm -v a");
    expect(current.round).toBe(secondRound as Round);
  });

  test("returns answer FollowupResult and leaves current unchanged", async () => {
    const { provider } = makeProvider([
      { type: "answer", content: "the answer", risk_level: "low" } as CommandResponse,
    ]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const current = makeCurrent();
    const originalRound = current.round;
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      current,
    });

    const r = await handler("just tell me", new AbortController().signal);
    expect(r.type).toBe("answer");
    if (r.type === "answer") expect(r.content).toBe("the answer");

    // The answer round is logged inline by runRoundsUntilFinal.
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0]?.parsed?.type).toBe("answer");
    // current.round is unchanged — no command came back to swap in.
    expect(current.round).toBe(originalRound);
  });

  test("returns exhausted FollowupResult when budget runs out", async () => {
    const probe = { type: "probe", content: "true", risk_level: "low" } as CommandResponse;
    const { provider } = makeProvider([probe, probe, probe, probe, probe]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const current = makeCurrent();
    const originalRound = current.round;
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: { ...makeOptions(), maxRounds: 3 },
      current,
    });

    const r = await handler("hmm", new AbortController().signal);
    expect(r.type).toBe("exhausted");
    expect(current.round).toBe(originalRound);
  });

  test("aborts mid-flight: drops command result, logs the orphan round, leaves current untouched", async () => {
    // Race: the loop completes a real command BUT the user pressed Esc just
    // before the result resolved. The closure must NOT mutate `current`
    // (the dialog will drop the result anyway, and polluted state would
    // corrupt the user's next action). The orphan round is still in
    // entry.rounds via eager logging in runRoundsUntilFinal.
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
    const current = makeCurrent("rm a", "high");
    const originalResponse = current.response;
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      current,
    });

    const handlerPromise = handler("safer", controller.signal);
    // Wait a tick so the inner runPrompt is awaiting our resolver.
    await new Promise((r) => setTimeout(r, 10));
    // User presses Esc — abort the signal before the loop's result resolves.
    controller.abort();
    pending.resolve?.({
      type: "command",
      content: "rm -i a",
      risk_level: "low",
    } as CommandResponse);
    const r = await handlerPromise;

    expect(r.type).toBe("aborted");
    // current is NOT mutated — original command preserved for the user.
    expect(current.response).toBe(originalResponse);
    expect(current.response.content).toBe("rm a");
    // The orphan round is in entry.rounds via eager logging — useful for
    // the audit trail since the LLM did real work.
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0]?.parsed?.content).toBe("rm -i a");
  });

  test("returns aborted FollowupResult when signal is aborted before any LLM call", async () => {
    const { provider } = makeProvider([]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const current = makeCurrent();
    const originalRound = current.round;
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      current,
    });

    const controller = new AbortController();
    controller.abort();
    const r = await handler("nope", controller.signal);
    expect(r.type).toBe("aborted");
    expect(current.round).toBe(originalRound);
    expect(entry.rounds).toHaveLength(0);
  });

  test("strips stale instructions before pushing follow-up turn", async () => {
    const input = makeInput([{ role: "user", content: promptConstants.lastRoundInstruction }]);
    const { provider } = makeProvider([
      { type: "command", content: "echo done", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const current = makeCurrent();
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      current,
    });

    await handler("refine", new AbortController().signal);

    const stale = input.messages.some((m) => m.content === promptConstants.lastRoundInstruction);
    expect(stale).toBe(false);
    const hasFollowup = input.messages.some((m) => m.role === "user" && m.content === "refine");
    expect(hasFollowup).toBe(true);
  });

  test("pushes assistant JSON of current.response before follow-up text", async () => {
    const input = makeInput();
    const { provider } = makeProvider([
      { type: "command", content: "ls", risk_level: "low" } as CommandResponse,
    ]);
    const state: LoopState = { budgetRemaining: 0, roundNum: 1 };
    const entry = makeEntry();
    const current = makeCurrent();
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: makeOptions(),
      current,
    });

    await handler("safer please", new AbortController().signal);

    const idx = input.messages.findIndex(
      (m) => m.role === "assistant" && m.content.includes("rm a"),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(input.messages[idx + 1]?.role).toBe("user");
    expect(input.messages[idx + 1]?.content).toBe("safer please");
  });

  test("resets budgetRemaining to maxRounds before re-entering the loop", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "echo ok", risk_level: "low" } as CommandResponse,
    ]);
    const input = makeInput();
    const state: LoopState = { budgetRemaining: 0, roundNum: 5 };
    const entry = makeEntry();
    const current = makeCurrent();
    const handler = createFollowupHandler({
      provider,
      input,
      state,
      entry,
      options: { ...makeOptions(), maxRounds: 5 },
      current,
    });

    await handler("hmm", new AbortController().signal);

    // Budget was reset to 5, then decremented once for the single round = 4.
    expect(state.budgetRemaining).toBe(4);
    // Round counter is monotonic — incremented from 5 to 6.
    expect(state.roundNum).toBe(6);
  });
});
