import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { setConfig } from "../src/config/store.ts";
import {
  fetchesUrl,
  type LoopEvent,
  type LoopOptions,
  type LoopReturn,
  type LoopState,
  runLoop,
} from "../src/core/runner.ts";
import type { Transcript } from "../src/core/transcript.ts";
import type { PromptScaffold } from "../src/llm/build-prompt.ts";
import type { Provider } from "../src/llm/types.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

const scaffold: PromptScaffold = {
  system: "system",
  prefixMessages: [],
  initialUserText: "",
};

let stderr: MockStderr;
let tmpHome: string;

beforeEach(() => {
  setConfig({ verbose: false });
  stderr = mockStderr();
  tmpHome = mkdtempSync(join(tmpdir(), "wrap-runner-test-"));
});

afterEach(() => {
  stderr.restore();
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeProvider(responses: CommandResponse[]): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    runPrompt: async () => {
      const r = responses[calls];
      calls += 1;
      if (!r) throw new Error(`unexpected call ${calls}`);
      return r;
    },
  };
  return { provider, calls: () => calls };
}

function makeOptions(overrides?: Partial<LoopOptions>): LoopOptions {
  return {
    cwd: "/tmp",
    wrapHome: tmpHome,
    model: "test / model",
    pipedInput: undefined,
    showSpinner: false,
    ...overrides,
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
  test("single-iteration command yields round-complete and pushes a candidate_command turn", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "ls", risk_level: "medium" } as CommandResponse,
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(provider, transcript, scaffold, state, makeOptions()),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("round-complete");
    expect(final.type).toBe("command");
    expect(transcript.length).toBe(2);
    expect(transcript[1]?.kind).toBe("candidate_command");
  });

  test("single-iteration answer pushes an answer turn and returns answer", async () => {
    const { provider } = makeProvider([
      { type: "reply", content: "hi back", risk_level: "low" } as CommandResponse,
    ]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { final } = await drain(runLoop(provider, transcript, scaffold, state, makeOptions()));
    expect(final.type).toBe("answer");
    expect(transcript[1]?.kind).toBe("answer");
  });

  test("non-final low: runs inline, pushes a step turn, continues the loop", async () => {
    const { provider } = makeProvider([
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
      runLoop(provider, transcript, scaffold, state, makeOptions()),
    );
    expect(final.type).toBe("command");
    const stepEvents = events.filter((e) => e.type === "step-running" || e.type === "step-output");
    expect(stepEvents.length).toBe(2);
    // One step turn + one candidate_command turn were pushed.
    expect(transcript.map((t) => t.kind)).toEqual(["user", "step", "candidate_command"]);
  });

  test("non-final medium: returns to coordinator without executing", async () => {
    // Step 4 leaves confirmation for step 5, but runLoop must already
    // surface non-final non-low as a LoopReturn so the coordinator can
    // route it to the dialog. Here we just pin that it does NOT run inline.
    const { provider } = makeProvider([
      {
        type: "command",
        final: false,
        content: "git stash",
        risk_level: "medium",
        plan: "stash, test, then pop",
      },
    ]);
    const transcript: Transcript = [{ kind: "user", text: "test clean" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(provider, transcript, scaffold, state, makeOptions()),
    );
    expect(final.type).toBe("command");
    // No step-running / step-output yielded — the runner did not execute.
    expect(events.some((e) => e.type === "step-running")).toBe(false);
    // A candidate_command turn was pushed (not a step).
    expect(transcript[1]?.kind).toBe("candidate_command");
  });

  test("exhausted when budget runs out", async () => {
    const step: CommandResponse = {
      type: "command",
      final: false,
      content: "true",
      risk_level: "low",
    };
    const { provider } = makeProvider([step, step, step]);
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 2, roundNum: 0 };
    setConfig({ verbose: false, maxRounds: 2 });
    const { final } = await drain(runLoop(provider, transcript, scaffold, state, makeOptions()));
    expect(final.type).toBe("exhausted");
    expect(state.roundNum).toBe(2);
  });

  test("aborted at top of iteration when signal already aborted", async () => {
    const { provider, calls } = makeProvider([]);
    const ctrl = new AbortController();
    ctrl.abort();
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(provider, transcript, scaffold, state, makeOptions({ signal: ctrl.signal })),
    );
    expect(final.type).toBe("aborted");
    expect(events).toHaveLength(0);
    expect(calls()).toBe(0);
  });

  test("abort fired between iterations: top check returns aborted", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const provider: Provider = {
      runPrompt: async () => {
        calls += 1;
        if (calls === 1) {
          ctrl.abort();
          return {
            type: "command",
            final: false,
            content: "true",
            risk_level: "low",
          } as CommandResponse;
        }
        throw new Error("should not reach second call");
      },
    };
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { final } = await drain(
      runLoop(provider, transcript, scaffold, state, makeOptions({ signal: ctrl.signal })),
    );
    expect(final.type).toBe("aborted");
    expect(calls).toBe(1);
  });

  test("orphan-turn race: abort during runRound await — no candidate_command pushed", async () => {
    // Test provider returns a command but the controller is aborted while the
    // provider promise is resolving. The post-await abort check must see the
    // aborted signal and return without pushing a transcript turn or yielding
    // round-complete.
    const ctrl = new AbortController();
    const provider: Provider = {
      runPrompt: async () => {
        // Abort the signal as the response resolves — simulates the race
        // where the user pressed Esc just before the call returned.
        ctrl.abort();
        return {
          type: "command",
          content: "ls",
          risk_level: "low",
        } as CommandResponse;
      },
    };
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const { events, final } = await drain(
      runLoop(provider, transcript, scaffold, state, makeOptions({ signal: ctrl.signal })),
    );
    expect(final.type).toBe("aborted");
    // No round-complete yielded.
    expect(events.filter((e) => e.type === "round-complete")).toHaveLength(0);
    // No orphan candidate_command turn.
    expect(transcript.length).toBe(1);
  });

  test("round-complete is yielded BEFORE the runRound throw propagates", async () => {
    // Simulate a provider that throws after the test provider's first call.
    let calls = 0;
    const provider: Provider = {
      runPrompt: async () => {
        calls += 1;
        throw new Error("network down");
      },
    };
    const transcript: Transcript = [{ kind: "user", text: "hi" }];
    const state: LoopState = { budgetRemaining: 5, roundNum: 0 };
    const events: LoopEvent[] = [];
    let thrown: unknown;
    try {
      const gen = runLoop(provider, transcript, scaffold, state, makeOptions());
      while (true) {
        const { value, done } = await gen.next();
        if (done) break;
        events.push(value);
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The errored round was still yielded so the consumer can log it.
    expect(events.filter((e) => e.type === "round-complete")).toHaveLength(1);
    expect(calls).toBe(1);
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
