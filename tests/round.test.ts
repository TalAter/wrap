import { beforeEach, describe, expect, test } from "bun:test";
import { type Conversation, LlmAbortError, replayable } from "wrap-core/llm";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { RoundError, runRound } from "../src/core/round.ts";
import { resetVerboseTimer } from "../src/core/verbose.ts";
import { projectResponseForEcho } from "../src/llm/framing.ts";
import promptConstants from "../src/prompt.constants.json";
import { makeChat, physicalCalls } from "./helpers/llm-fixtures.ts";
import { seedTestConfig } from "./helpers.ts";
import { capturedStderr as stderr } from "./preload.ts";

beforeEach(() => {
  seedTestConfig();
  resetVerboseTimer();
});

const defaultOptions = { isLastRound: false, label: "test", showSpinner: false };

/** The assembled request behind the LAST physical call of the round. */
function lastRequest(chat: Conversation) {
  const attempts = chat.entries.flatMap((e) => e.attempts ?? []);
  return attempts.at(-1)?.request;
}

describe("runRound", () => {
  test("returns an AssistantTurn with response set on a successful command", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    const turn = await runRound(chat, defaultOptions);
    expect(turn.kind).toBe("assistant");
    expect(turn.source).toBe("model");
    expect(turn.response?.type).toBe("command");
    expect(turn.response?.content).toBe("ls");
    expect(typeof turn.llm_ms).toBe("number");
  });

  test("returns an AssistantTurn with response set on a successful answer", async () => {
    const chat = makeChat([{ type: "reply", content: "hello", risk_level: "low" }]);
    const turn = await runRound(chat, defaultOptions);
    expect(turn.response?.type).toBe("reply");
  });

  test("a successful round leaves exactly [user, assistant echo] replayable", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    await runRound(chat, defaultOptions);
    const replayed = chat.entries.filter(replayable).map((e) => e.message);
    expect(replayed).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: JSON.stringify(
          projectResponseForEcho({
            type: "command",
            content: "ls",
            risk_level: "low",
            final: true,
          } as CommandResponse),
        ),
      },
    ]);
  });

  test("the LLM sees a temp-dir listing as live context each round", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    await runRound(chat, defaultOptions);
    const userMessages = lastRequest(chat)?.messages.filter((m) => m.role === "user") ?? [];
    expect(userMessages.some((m) => m.content.includes("$WRAP_TEMP_DIR"))).toBe(true);
  });

  test("with isLastRound: true the LLM sees lastRoundInstruction", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    await runRound(chat, { ...defaultOptions, isLastRound: true });
    const userMessages = lastRequest(chat)?.messages.filter((m) => m.role === "user") ?? [];
    expect(userMessages.some((m) => m.content === promptConstants.lastRoundInstruction)).toBe(true);
  });

  test("with isLastRound: false the LLM does not see lastRoundInstruction", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    await runRound(chat, defaultOptions);
    const userMessages = lastRequest(chat)?.messages.filter((m) => m.role === "user") ?? [];
    expect(userMessages.some((m) => m.content === promptConstants.lastRoundInstruction)).toBe(
      false,
    );
  });

  test("per-round transients are not resurrected on the next round", async () => {
    const chat = makeChat([
      { type: "command", final: false, content: "echo probe", risk_level: "low" },
      { type: "command", content: "echo done", risk_level: "low" },
    ]);
    await runRound(chat, { ...defaultOptions, isLastRound: true });
    chat.add({ role: "user", content: "follow-up" });
    await runRound(chat, defaultOptions);
    const messages = lastRequest(chat)?.messages ?? [];
    const tempDirSections = messages.filter((m) =>
      m.content.startsWith(promptConstants.sectionTempDir),
    );
    // Round 2 carries its own listing exactly once — round 1's consumed
    // transient (and its last-round instruction) must not replay.
    expect(tempDirSections).toHaveLength(1);
    expect(messages.some((m) => m.content === promptConstants.lastRoundInstruction)).toBe(false);
  });

  test("throws RoundError on empty content with the partial round attached", async () => {
    const chat = makeChat([{ type: "reply", content: "   ", risk_level: "low" }]);
    let thrown: unknown;
    try {
      await runRound(chat, defaultOptions);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoundError);
    if (thrown instanceof RoundError) {
      expect(thrown.message).toBe("LLM returned an empty response.");
      expect(thrown.turn.attempts.at(-1)?.parsed).toBeDefined();
      expect(thrown.turn.attempts.at(-1)?.error?.kind).toBe("empty");
    }
  });

  test("throws RoundError with the model label on a provider failure", async () => {
    const chat = makeChat("ERROR:network down");
    let thrown: unknown;
    try {
      await runRound(chat, { ...defaultOptions, label: "test / model" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoundError);
    if (thrown instanceof RoundError) {
      expect(thrown.message).toContain("test / model");
      expect(thrown.message).toContain("network down");
      expect(thrown.turn.attempts[0]?.error?.kind).toBe("provider");
      expect(thrown.turn.attempts[0]?.error?.message).toBe("network down");
    }
  });

  test("an unparsable response is retried once by the send, then fails the round", async () => {
    // Single canned response repeats across both physical attempts. Core owns
    // the parse retry; wrap surfaces the typed failure as a RoundError with
    // both attempts on the partial turn.
    const chat = makeChat("not json at all");
    let thrown: unknown;
    try {
      await runRound(chat, { ...defaultOptions, label: "test / model" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoundError);
    if (thrown instanceof RoundError) {
      expect(thrown.turn.attempts).toHaveLength(2);
      expect(thrown.turn.attempts[0]?.error?.kind).toBe("parse");
      expect(thrown.turn.attempts[1]?.error?.kind).toBe("parse");
      // raw_response is the default-config debugging breadcrumb on parse failures.
      expect(thrown.turn.attempts[0]?.raw_response).toBe("not json at all");
      expect(thrown.message).toContain("test / model");
    }
  });

  test("recovers when the parse retry succeeds (two attempts, one round)", async () => {
    const chat = makeChat(["not json", { type: "command", content: "ls", risk_level: "low" }]);
    const turn = await runRound(chat, defaultOptions);
    expect(turn.attempts).toHaveLength(2);
    expect(turn.attempts[0]?.error?.kind).toBe("parse");
    expect(turn.attempts[0]?.parsed).toBeUndefined();
    expect(turn.attempts.at(-1)?.parsed?.content).toBe("ls");
  });

  test("verbose prints _scratchpad line before the response line when present", async () => {
    seedTestConfig({ verbose: true });
    const chat = makeChat([
      {
        _scratchpad: "Need to plan first.\nSecond thought.",
        type: "command",
        content: "ls",
        risk_level: "low",
      },
    ]);
    await runRound(chat, defaultOptions);
    expect(stderr.text).toContain("LLM scratchpad: ");
    expect(stderr.text).toContain("Need to plan first. \\n Second thought.");
    const scratchIdx = stderr.text.indexOf("LLM scratchpad");
    const respondedIdx = stderr.text.indexOf("LLM responded");
    expect(scratchIdx).toBeGreaterThanOrEqual(0);
    expect(respondedIdx).toBeGreaterThan(scratchIdx);
  });

  test("verbose prints nothing when scratchpad is absent", async () => {
    seedTestConfig({ verbose: true });
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    await runRound(chat, defaultOptions);
    expect(stderr.text).not.toContain("scratchpad");
  });

  test("sums llm_ms across attempts into turn.llm_ms", async () => {
    const chat = makeChat(["not json", { type: "command", content: "ls", risk_level: "low" }]);
    const turn = await runRound(chat, defaultOptions);
    expect(turn.attempts).toHaveLength(2);
    const per = turn.attempts.reduce((sum, a) => sum + (a.llm_ms ?? 0), 0);
    expect(turn.llm_ms).toBe(per);
  });

  test("a pre-aborted signal throws LlmAbortError before any transient is added", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    const before = chat.entries.length;
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runRound(chat, { ...defaultOptions, signal: ctrl.signal })).rejects.toBeInstanceOf(
      LlmAbortError,
    );
    // No stale transients left behind for the next round to replay.
    expect(chat.entries.length).toBe(before);
  });
});

describe("runRound — scratchpad retry (domain logic)", () => {
  const rejected = {
    _scratchpad: null,
    type: "command",
    content: "echo rm-rf-node-modules-fake",
    risk_level: "high",
  };

  test("retries once when a high-risk command has a null scratchpad", async () => {
    const chat = makeChat([
      rejected,
      {
        _scratchpad: "Destructive: blow away deps for a clean install.",
        type: "command",
        content: "echo rm-rf-node-modules-fake",
        risk_level: "high",
      },
    ]);
    const turn = await runRound(chat, defaultOptions);
    expect(physicalCalls(chat)).toBe(2);
    expect(turn.attempts).toHaveLength(2);
    expect(turn.attempts[0]?.parsed?._scratchpad).toBeNull();
    expect(turn.attempts.at(-1)?.parsed?._scratchpad).toBe(
      "Destructive: blow away deps for a clean install.",
    );
    // The retry request carries the raw rejected JSON (null scratchpad
    // preserved so the model sees what to fix) plus the instruction.
    const messages = lastRequest(chat)?.messages ?? [];
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(promptConstants.scratchpadRequiredInstruction);
    const echo = messages.at(-2);
    expect(echo?.role).toBe("assistant");
    expect(echo?.content).toContain('"_scratchpad":null');
  });

  test("the filled-scratchpad response echoes via the predicate (scratchpad stripped)", async () => {
    const filled = {
      _scratchpad: "Destructive cleanup, on purpose.",
      type: "command",
      content: "echo rm-rf-node-modules-fake",
      risk_level: "high",
    };
    const chat = makeChat([rejected, filled]);
    await runRound(chat, defaultOptions);
    const replayed = chat.entries.filter(replayable).map((e) => e.message);
    expect(replayed.at(-1)).toEqual({
      role: "assistant",
      content: JSON.stringify(
        projectResponseForEcho({ ...filled, final: true } as CommandResponse),
      ),
    });
  });

  test("does not retry when a high-risk command already has a scratchpad", async () => {
    const chat = makeChat([
      {
        _scratchpad: "Blowing away node_modules for a clean install.",
        type: "command",
        content: "echo rm-rf-node-modules-fake",
        risk_level: "high",
      },
    ]);
    await runRound(chat, defaultOptions);
    expect(physicalCalls(chat)).toBe(1);
  });

  test("does not retry for medium risk with a null scratchpad", async () => {
    const chat = makeChat([
      { _scratchpad: null, type: "command", content: "mkdir build", risk_level: "medium" },
    ]);
    await runRound(chat, defaultOptions);
    expect(physicalCalls(chat)).toBe(1);
  });

  test("accepts a still-null scratchpad after the retry without a third call", async () => {
    const chat = makeChat([rejected, rejected]);
    const turn = await runRound(chat, defaultOptions);
    expect(physicalCalls(chat)).toBe(2);
    expect(turn.attempts.at(-1)?.parsed?.type).toBe("command");
    // Accepted-anyway responses settle through an explicit add: the round's
    // echo is replayable even though the predicate rejected both sends.
    const replayed = chat.entries.filter(replayable).map((e) => e.message);
    expect(replayed.at(-1)).toEqual({
      role: "assistant",
      content: JSON.stringify(
        projectResponseForEcho({ ...rejected, final: true } as CommandResponse),
      ),
    });
  });

  test("keeps response #1 when the scratchpad retry fails to parse", async () => {
    // Send #2 burns both of its physical attempts on unparsable output; the
    // round keeps the original response for execution and settles its echo.
    const chat = makeChat([rejected, "not json", "still not json"]);
    const turn = await runRound(chat, defaultOptions);
    expect(physicalCalls(chat)).toBe(3);
    expect(turn.attempts).toHaveLength(3);
    expect(turn.response?.content).toBe("echo rm-rf-node-modules-fake");
    expect(turn.attempts.at(-1)?.error?.kind).toBe("parse");
    const replayed = chat.entries.filter(replayable).map((e) => e.message);
    expect(replayed.at(-1)).toEqual({
      role: "assistant",
      content: JSON.stringify(
        projectResponseForEcho({ ...rejected, final: true } as CommandResponse),
      ),
    });
  });

  test("a provider failure during the scratchpad retry fails the round with the partial turn", async () => {
    const chat = makeChat([rejected, "ERROR:rate limited"]);
    let thrown: unknown;
    try {
      await runRound(chat, { ...defaultOptions, label: "test / model" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoundError);
    if (thrown instanceof RoundError) {
      expect(thrown.message).toContain("rate limited");
      expect(thrown.turn.attempts).toHaveLength(2);
      // Response #1 was valid — the partial turn keeps it for the log.
      expect(thrown.turn.response?.content).toBe("echo rm-rf-node-modules-fake");
    }
  });
});

describe("runRound — trace gating (logTraces)", () => {
  test("attempts carry no request/wire fields by default", async () => {
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    const turn = await runRound(chat, defaultOptions);
    const attempt = turn.attempts[0] ?? {};
    expect("request" in attempt).toBe(false);
    expect("request_wire" in attempt).toBe(false);
    expect("response_wire" in attempt).toBe(false);
    expect("raw_response" in attempt).toBe(false);
  });

  test("logTraces: attempts carry request, wires, and raw_response", async () => {
    seedTestConfig({ logTraces: true });
    const chat = makeChat([{ type: "command", content: "ls", risk_level: "low" }]);
    const turn = await runRound(chat, defaultOptions);
    const attempt = turn.attempts[0];
    expect(attempt?.request?.system).toBe("system");
    expect(Array.isArray(attempt?.request?.messages)).toBe(true);
    expect(attempt?.request_wire?.kind).toBe("test");
    expect(attempt?.response_wire?.kind).toBe("test");
    expect(typeof attempt?.raw_response).toBe("string");
  });
});
