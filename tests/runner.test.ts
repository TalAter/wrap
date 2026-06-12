import { beforeEach, describe, expect, test } from "bun:test";
import { type Conversation, type Entry, LlmAbortError, replayable } from "wrap-core/llm";
import {
  fetchesUrl,
  type LoopEvent,
  type LoopOptions,
  type LoopReturn,
  type LoopState,
  runLoop,
} from "../src/core/runner.ts";
import { createTurnFramer, type Transcript } from "../src/llm/framing.ts";
import type { Turn } from "../src/logging/entry.ts";
import { makeChat, physicalCalls } from "./helpers/llm-fixtures.ts";
import { seedTestConfig } from "./helpers.ts";

beforeEach(() => {
  seedTestConfig();
});

/** Minimal hand-rolled conversation for abort-interleaving tests where the
 *  canned provider can't fire mid-send hooks. */
function stubChat(send: (opts?: { signal?: AbortSignal }) => Promise<unknown>): Conversation {
  const entries: Entry[] = [];
  return {
    add(message, opts) {
      entries.push({ message, ...(opts?.transient ? { transient: true } : {}) });
    },
    get entries() {
      return entries;
    },
    send: send as Conversation["send"],
  } as Conversation;
}

function makeOptions(overrides?: Partial<LoopOptions>): LoopOptions {
  return {
    cwd: "/tmp",
    model: "test / model",
    showSpinner: false,
    ...overrides,
  };
}

/** The session's `appendTurn` gate, rebuilt for tests: a turn lands on the
 *  transcript AND (framed) on the live conversation. */
function makeAppend(chat: Conversation, transcript: Transcript): (turn: Turn) => void {
  const framer = createTurnFramer();
  return (turn) => {
    transcript.push(turn);
    for (const message of framer.frame(turn)) chat.add(message);
  };
}

async function drain(
  gen: AsyncGenerator<LoopEvent, LoopReturn>,
): Promise<{ events: LoopEvent[]; final: LoopReturn }> {
  const events: LoopEvent[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { events, final: value };
    events.push(value);
  }
}

describe("runLoop", () => {
  test("single-iteration command yields assistant-turn and pushes one assistant turn", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "medium" }]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("assistant-turn");
    expect(final.type).toBe("command");
    expect(transcript.length).toBe(2);
    expect(transcript[1]?.kind).toBe("assistant");
  });

  test("single-iteration answer pushes an assistant turn and returns answer", async () => {
    const chat = makeChat([{ type: "reply", content: "hi back", risk_level: "low" }]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(final.type).toBe("answer");
    expect(transcript[1]?.kind).toBe("assistant");
  });

  test("non-final low: runs inline, pushes assistant + step turns, continues the loop", async () => {
    const chat = makeChat([
      {
        type: "command",
        final: false,
        content: "echo discovered",
        risk_level: "low",
        explanation: "check",
      },
      { type: "command", final: true, content: "echo done", risk_level: "low" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(final.type).toBe("command");
    const stepEvents = events.filter((e) => e.type === "step-running" || e.type === "step-output");
    expect(stepEvents.length).toBe(2);
    // user, assistant (step response), step (output), assistant (final command)
    expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant", "step", "assistant"]);
  });

  test("step turns are framed into the conversation as they happen", async () => {
    const chat = makeChat([
      {
        type: "command",
        final: false,
        content: "echo discovered",
        risk_level: "low",
        explanation: "check",
      },
      { type: "command", final: true, content: "echo done", risk_level: "low" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    await drain(runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()));
    // Replayable conversation mirrors the transcript: user, step echo (from
    // the send), captured output, final echo.
    const replayed = chat.entries.filter(replayable).map((e) => e.message);
    expect(replayed.map((m) => m?.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(replayed[2]?.content).toContain("## Captured output");
    expect(replayed[2]?.content).toContain("discovered");
  });

  test("yolo + non-final medium: runs inline, pushes assistant + step turns, continues the loop", async () => {
    seedTestConfig({ yolo: true });
    const chat = makeChat([
      {
        type: "command",
        final: false,
        content: "echo discovered",
        risk_level: "medium",
        explanation: "check",
      },
      { type: "command", final: true, content: "echo done", risk_level: "low" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(final.type).toBe("command");
    const stepEvents = events.filter((e) => e.type === "step-running" || e.type === "step-output");
    expect(stepEvents.length).toBe(2);
    expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant", "step", "assistant"]);
  });

  test("yolo + non-final high: runs inline (any non-low non-final runs in yolo)", async () => {
    seedTestConfig({ yolo: true });
    const chat = makeChat([
      {
        type: "command",
        final: false,
        content: "echo danger",
        risk_level: "high",
        explanation: "cleanup",
        // Present to skip runRound's scratchpad-retry path, which would
        // consume the second canned response.
        _scratchpad: "noop",
      },
      { type: "command", final: true, content: "echo done", risk_level: "low" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(events.some((e) => e.type === "step-running")).toBe(true);
    expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant", "step", "assistant"]);
  });

  test("non-final medium: returns to coordinator without executing", async () => {
    const chat = makeChat([
      {
        type: "command",
        final: false,
        content: "echo git-stash-fake",
        risk_level: "medium",
        plan: "stash, test, then pop",
      },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "test clean" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(final.type).toBe("command");
    // No step-running / step-output yielded — the runner did not execute.
    expect(events.some((e) => e.type === "step-running")).toBe(false);
    // An assistant turn was pushed (not a step turn).
    expect(transcript[1]?.kind).toBe("assistant");
  });

  test("exhausted when budget runs out", async () => {
    const step = { type: "command", final: false, content: "true", risk_level: "low" };
    const chat = makeChat([step, step, step]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 2, roundNum: 0 };
    seedTestConfig({ maxRounds: 2 });
    const { final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(final.type).toBe("exhausted");
    expect(state.roundNum).toBe(2);
  });

  test("last-round non-final low: returns exhausted without executing the step", async () => {
    // The last-round guard rejects a non-final response on the final round
    // (the LLM was told to return command-or-answer). The step must NOT run
    // and the transcript must NOT gain a step turn.
    const chat = makeChat([
      {
        type: "command",
        final: false,
        content: "echo should-not-run",
        risk_level: "low",
        explanation: "ignored on last round",
      },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 1, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
    );
    expect(final.type).toBe("exhausted");
    expect(events.some((e) => e.type === "step-running")).toBe(false);
    expect(events.some((e) => e.type === "step-output")).toBe(false);
    // The assistant turn for the (rejected) response still got pushed;
    // no step turn followed because the runner bails out.
    expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant"]);
  });

  test("inline-step output inserts a newline boundary between stdout and stderr", async () => {
    // Pin SHELL so stderr capture is predictable across platforms; runner
    // forwards process.env to executeShellCommand. Use printf (no trailing
    // newline) so the only "\n" between OUT and the stderr half comes from
    // the runner's own separator — a missing-separator mutant runs OUT into
    // the stderr content with no newline.
    const savedShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      const chat = makeChat([
        {
          type: "command",
          final: false,
          content: "printf OUT; printf ERR >&2",
          risk_level: "low",
          explanation: "stderr-merge",
        },
        { type: "command", final: true, content: "true", risk_level: "low" },
      ]);
      const transcript: Transcript = [{ kind: "user", text: "hi" }];
      const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
      const { events } = await drain(
        runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions()),
      );
      const stepOutputs = events.filter(
        (e): e is Extract<LoopEvent, { type: "step-output" }> => e.type === "step-output",
      );
      expect(stepOutputs).toHaveLength(1);
      const text = stepOutputs[0]?.text ?? "";
      // Boundary "\n" right after stdout ("OUT") — without the runner's
      // separator, "OUT" would butt up against the stderr content.
      expect(text).toMatch(/^OUT\n/);
      // stderr content is preserved (substring — sh -i may prepend a "no job
      // control" warning before "ERR").
      expect(text).toContain("ERR");
    } finally {
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }
  });

  test("aborted at top of iteration when signal already aborted", async () => {
    const chat = makeChat("ERROR:should never be called");
    const ctrl = new AbortController();
    ctrl.abort();
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(
        chat,
        makeAppend(chat, transcript),
        transcript,
        state,
        makeOptions({ signal: ctrl.signal }),
      ),
    );
    expect(final.type).toBe("aborted");
    expect(events).toHaveLength(0);
    expect(physicalCalls(chat)).toBe(0);
  });

  test("abort fired after a completed step: top-of-iteration check returns aborted", async () => {
    const ctrl = new AbortController();
    const chat = makeChat([
      { type: "command", final: false, content: "true", risk_level: "low", explanation: "ok" },
      { type: "command", final: true, content: "true", risk_level: "low" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const gen = runLoop(
      chat,
      makeAppend(chat, transcript),
      transcript,
      state,
      makeOptions({ signal: ctrl.signal }),
    );
    let final: LoopReturn | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        final = value;
        break;
      }
      // Abort as the step's output lands — the step turn still records, the
      // next iteration's top check bails before another LLM call.
      if (value.type === "step-output") ctrl.abort();
    }
    expect(final?.type).toBe("aborted");
    expect(physicalCalls(chat)).toBe(1);
    expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant", "step"]);
  });

  test("aborted send (LlmAbortError) returns aborted with no assistant turn pushed", async () => {
    // Core's send rejects with LlmAbortError the moment the signal fires —
    // the entry was sealed with nothing replayable; the runner must map it
    // to the aborted return without pushing or yielding a turn.
    const ctrl = new AbortController();
    const chat = stubChat(async () => {
      ctrl.abort();
      throw new LlmAbortError();
    });
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(
        chat,
        makeAppend(chat, transcript),
        transcript,
        state,
        makeOptions({ signal: ctrl.signal }),
      ),
    );
    expect(final.type).toBe("aborted");
    expect(events.filter((e) => e.type === "assistant-turn")).toHaveLength(0);
    expect(transcript.length).toBe(1);
  });

  test("orphan-turn race: abort during step exec returns aborted, no step turn pushed", async () => {
    const ctrl = new AbortController();
    const chat = makeChat([
      { type: "command", final: false, content: "true", risk_level: "low", explanation: "ok" },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const gen = runLoop(
      chat,
      makeAppend(chat, transcript),
      transcript,
      state,
      makeOptions({ signal: ctrl.signal }),
    );
    let final: LoopReturn | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        final = value;
        break;
      }
      if (value.type === "step-running") ctrl.abort();
    }
    expect(final?.type).toBe("aborted");
    // The assistant turn for the step response made it onto the transcript
    // before the exec was aborted; no step turn followed.
    expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant"]);
  });

  test("assistant-turn is yielded BEFORE the runRound throw propagates", async () => {
    const chat = makeChat("ERROR:network down");
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const events: LoopEvent[] = [];
    let thrown: unknown;
    try {
      const gen = runLoop(chat, makeAppend(chat, transcript), transcript, state, makeOptions());
      while (true) {
        const { value, done } = await gen.next();
        if (done) break;
        events.push(value);
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The errored turn was still yielded so the consumer can log it.
    expect(events.filter((e) => e.type === "assistant-turn")).toHaveLength(1);
    expect(physicalCalls(chat)).toBe(1);
  });
});

describe("fetchesUrl", () => {
  test("returns true for curl URL", () => {
    expect(fetchesUrl("curl https://example.com")).toBe(true);
  });

  test("returns true for wget URL", () => {
    expect(fetchesUrl("wget http://example.com")).toBe(true);
  });

  test("returns false for non-fetch step commands", () => {
    expect(fetchesUrl("ls")).toBe(false);
  });
});
