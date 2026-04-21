import { beforeEach, describe, expect, test } from "bun:test";
import { reduce } from "../src/session/reducer.ts";
import type { AppState } from "../src/session/state.ts";
import {
  makeComposing,
  makeConfirming,
  makeEditing,
  makeExecutingStep,
  makeProcessing,
  makeResponse,
  makeRound,
} from "./helpers/state-fixtures.ts";
import { seedTestConfig } from "./helpers.ts";

beforeEach(() => {
  seedTestConfig();
});

const lowCommand = makeResponse({ risk_level: "low", content: "echo hi" });
const mediumCommand = makeResponse({ risk_level: "medium", content: "echo rm-a-fake" });
const highCommand = makeResponse({ risk_level: "high", content: "echo rm-rf-fake" });

describe("reduce — thinking", () => {
  test("loop-final command low → exiting{run, source: model}", () => {
    const state: AppState = { tag: "thinking" };
    const round = makeRound(lowCommand);
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: lowCommand, round },
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting" && next.outcome.kind === "run") {
      expect(next.outcome.command).toBe("echo hi");
      expect(next.outcome.source).toBe("model");
      expect(next.outcome.response).toBe(lowCommand);
      expect(next.outcome.round).toBe(round);
    }
  });

  test("loop-final command medium → confirming", () => {
    const state: AppState = { tag: "thinking" };
    const round = makeRound(mediumCommand);
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: mediumCommand, round },
    });
    expect(next.tag).toBe("confirming");
    if (next.tag === "confirming") {
      expect(next.response).toBe(mediumCommand);
      expect(next.round).toBe(round);
    }
  });

  test("loop-final command high → confirming", () => {
    const state: AppState = { tag: "thinking" };
    const round = makeRound(highCommand);
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: highCommand, round },
    });
    expect(next.tag).toBe("confirming");
  });

  test("loop-final answer → exiting{answer}", () => {
    const state: AppState = { tag: "thinking" };
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "answer", content: "the answer" },
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting") {
      expect(next.outcome.kind).toBe("answer");
    }
  });

  test("loop-final exhausted → exiting{exhausted}", () => {
    const state: AppState = { tag: "thinking" };
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "exhausted" },
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting") {
      expect(next.outcome.kind).toBe("exhausted");
    }
  });

  test("loop-error → exiting{error}", () => {
    const state: AppState = { tag: "thinking" };
    const next = reduce(state, {
      type: "loop-error",
      error: new Error("boom"),
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting" && next.outcome.kind === "error") {
      expect(next.outcome.message).toBe("boom");
    }
  });

  test("block command → exiting{blocked}", () => {
    const state: AppState = { tag: "thinking" };
    const next = reduce(state, { type: "block", command: "echo rm-a-fake" });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting" && next.outcome.kind === "blocked") {
      expect(next.outcome.command).toBe("echo rm-a-fake");
    }
  });

  test("loop-final aborted from thinking → state by reference (defensive no-op)", () => {
    const state: AppState = { tag: "thinking" };
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "aborted" },
    });
    expect(next).toBe(state);
  });

  describe("yolo bypasses the confirmation dialog", () => {
    test("yolo + medium final command → exiting{run, source: model}", () => {
      seedTestConfig({ yolo: true });
      const state: AppState = { tag: "thinking" };
      const round = makeRound(mediumCommand);
      const next = reduce(state, {
        type: "loop-final",
        result: { type: "command", response: mediumCommand, round },
      });
      expect(next.tag).toBe("exiting");
      if (next.tag === "exiting" && next.outcome.kind === "run") {
        expect(next.outcome.command).toBe("echo rm-a-fake");
        expect(next.outcome.source).toBe("model");
      }
    });

    test("yolo + high final command → exiting{run, source: model}", () => {
      seedTestConfig({ yolo: true });
      const state: AppState = { tag: "thinking" };
      const round = makeRound(highCommand);
      const next = reduce(state, {
        type: "loop-final",
        result: { type: "command", response: highCommand, round },
      });
      expect(next.tag).toBe("exiting");
      if (next.tag === "exiting" && next.outcome.kind === "run") {
        expect(next.outcome.source).toBe("model");
      }
    });

    test("yolo + low final command → exiting{run} (same path as default)", () => {
      seedTestConfig({ yolo: true });
      const state: AppState = { tag: "thinking" };
      const round = makeRound(lowCommand);
      const next = reduce(state, {
        type: "loop-final",
        result: { type: "command", response: lowCommand, round },
      });
      expect(next.tag).toBe("exiting");
    });
  });
});

describe("reduce — confirming", () => {
  test("key-action run → exiting{run, source: model}", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "key-action", action: "run" });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting" && next.outcome.kind === "run") {
      expect(next.outcome.source).toBe("model");
      expect(next.outcome.command).toBe(state.response.content);
    }
  });

  test("key-action cancel → exiting{cancel}", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "key-action", action: "cancel" });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting") {
      expect(next.outcome.kind).toBe("cancel");
    }
  });

  test("key-action edit → editing with draft = command", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "key-action", action: "edit" });
    expect(next.tag).toBe("editing");
    if (next.tag === "editing") {
      expect(next.draft).toBe(state.response.content);
    }
  });

  test("key-action followup → composing with empty draft", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "key-action", action: "followup" });
    expect(next.tag).toBe("composing-followup");
    if (next.tag === "composing-followup") {
      expect(next.draft).toBe("");
    }
  });

  test("key-action copy → state by reference (no-op)", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "key-action", action: "copy" });
    expect(next).toBe(state);
  });

  test("key-esc → exiting{cancel}", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "key-esc" });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting") {
      expect(next.outcome.kind).toBe("cancel");
    }
  });
});

describe("reduce — editing", () => {
  test("key-esc → confirming with the original response/round", () => {
    const state = makeEditing({ draft: "echo rm-rf-wrong-fake" });
    const next = reduce(state, { type: "key-esc" });
    expect(next.tag).toBe("confirming");
    if (next.tag === "confirming") {
      expect(next.response).toBe(state.response);
      expect(next.round).toBe(state.round);
    }
  });

  test("submit-edit text → exiting{run, source: user_override}", () => {
    const state = makeEditing();
    const next = reduce(state, { type: "submit-edit", text: "echo overridden" });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting" && next.outcome.kind === "run") {
      expect(next.outcome.source).toBe("user_override");
      expect(next.outcome.command).toBe("echo overridden");
      expect(next.outcome.response).toBe(state.response);
      expect(next.outcome.command).not.toBe(state.response.content);
    }
  });

  test("draft-change → editing with new draft", () => {
    const state = makeEditing({ draft: "ls" });
    const next = reduce(state, { type: "draft-change", text: "ls -la" });
    expect(next.tag).toBe("editing");
    if (next.tag === "editing") {
      expect(next.draft).toBe("ls -la");
    }
  });
});

describe("reduce — composing", () => {
  test("key-esc → confirming (drop draft)", () => {
    const state = makeComposing({ draft: "be safer" });
    const next = reduce(state, { type: "key-esc" });
    expect(next.tag).toBe("confirming");
  });

  test("draft-change → composing with new draft", () => {
    const state = makeComposing({ draft: "" });
    const next = reduce(state, { type: "draft-change", text: "be safer" });
    expect(next.tag).toBe("composing-followup");
    if (next.tag === "composing-followup") {
      expect(next.draft).toBe("be safer");
    }
  });

  test("submit-followup text → processing with draft preserved and no status", () => {
    const state = makeComposing();
    const next = reduce(state, { type: "submit-followup", text: "be safer" });
    expect(next.tag).toBe("processing-followup");
    if (next.tag === "processing-followup") {
      expect(next.draft).toBe("be safer");
      expect(next.status).toBeUndefined();
    }
  });
});

describe("reduce — processing", () => {
  test("key-esc → composing with draft preserved", () => {
    const state = makeProcessing({ draft: "be safer" });
    const next = reduce(state, { type: "key-esc" });
    expect(next.tag).toBe("composing-followup");
    if (next.tag === "composing-followup") {
      expect(next.draft).toBe("be safer");
    }
  });

  test("notification chrome → processing with status updated", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "notification",
      notification: { kind: "chrome", text: "Probing the database" },
    });
    expect(next.tag).toBe("processing-followup");
    if (next.tag === "processing-followup") {
      expect(next.status).toBe("Probing the database");
    }
  });

  test("notification verbose → state by reference (no-op)", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "notification",
      notification: { kind: "verbose", line: "ignored\n" },
    });
    expect(next).toBe(state);
  });

  test("loop-final command low → confirming (low-risk asymmetry — opens dialog instead of skipping)", () => {
    const state = makeProcessing();
    const round = makeRound(lowCommand);
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: lowCommand, round },
    });
    expect(next.tag).toBe("confirming");
    if (next.tag === "confirming") {
      expect(next.response).toBe(lowCommand);
      expect(next.round).toBe(round);
    }
  });

  test("loop-final command medium → confirming with new command", () => {
    const state = makeProcessing();
    const round = makeRound(mediumCommand);
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: mediumCommand, round },
    });
    expect(next.tag).toBe("confirming");
    if (next.tag === "confirming") {
      expect(next.response).toBe(mediumCommand);
    }
  });

  test("loop-final answer → exiting{answer}", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "answer", content: "done" },
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting" && next.outcome.kind === "answer") {
      expect(next.outcome.content).toBe("done");
    }
  });

  test("loop-final exhausted → exiting{exhausted}", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "exhausted" },
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting") {
      expect(next.outcome.kind).toBe("exhausted");
    }
  });

  test("loop-final aborted → state by reference (defensive no-op)", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "aborted" },
    });
    expect(next).toBe(state);
  });

  test("loop-error → exiting{error}", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "loop-error",
      error: new Error("boom"),
    });
    expect(next.tag).toBe("exiting");
  });
});

describe("reduce — executing-step", () => {
  const nonFinalMed = makeResponse({
    final: false,
    risk_level: "medium",
    content: "echo git-stash-fake",
    plan: "stash, test, pop",
  });

  test("confirming + key-action run on non-final med → executing-step", () => {
    const state = makeConfirming({ response: nonFinalMed });
    const next = reduce(state, { type: "key-action", action: "run" });
    expect(next.tag).toBe("executing-step");
    if (next.tag === "executing-step") {
      expect(next.response).toBe(nonFinalMed);
    }
  });

  test("confirming + key-action run on final-low → exiting (not executing-step)", () => {
    const state = makeConfirming({
      response: makeResponse({ risk_level: "low", final: true }),
    });
    const next = reduce(state, { type: "key-action", action: "run" });
    expect(next.tag).toBe("exiting");
  });

  test("step-output notification while executing-step updates outputSlot", () => {
    const state = makeExecutingStep({ response: nonFinalMed });
    const next = reduce(state, {
      type: "notification",
      notification: { kind: "step-output", text: "captured body" },
    });
    if (next.tag === "executing-step") {
      expect(next.outputSlot).toBe("captured body");
    } else {
      throw new Error(`expected executing-step, got ${next.tag}`);
    }
  });

  test("step-output notification while processing updates outputSlot", () => {
    const state = makeProcessing();
    const next = reduce(state, {
      type: "notification",
      notification: { kind: "step-output", text: "processing-body" },
    });
    if (next.tag === "processing-followup") {
      expect(next.outputSlot).toBe("processing-body");
    } else {
      throw new Error(`expected processing, got ${next.tag}`);
    }
  });

  test("loop-final command from executing-step → confirming, preserves outputSlot", () => {
    const state = makeExecutingStep({ response: nonFinalMed, outputSlot: "prior step out" });
    const nextResponse = makeResponse({ final: true, content: "echo done" });
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: nextResponse, round: makeRound(nextResponse) },
    });
    if (next.tag === "confirming") {
      expect(next.response).toBe(nextResponse);
      expect(next.outputSlot).toBe("prior step out");
    } else {
      throw new Error(`expected confirming, got ${next.tag}`);
    }
  });

  test("loop-final reply from executing-step → exiting{answer}", () => {
    const state = makeExecutingStep({ response: nonFinalMed });
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "answer", content: "the answer" },
    });
    expect(next.tag).toBe("exiting");
    if (next.tag === "exiting") {
      expect(next.outcome.kind).toBe("answer");
    }
  });

  test("key-esc from executing-step → confirming (keeps prior state)", () => {
    const state = makeExecutingStep({ response: nonFinalMed, outputSlot: "so far" });
    const next = reduce(state, { type: "key-esc" });
    if (next.tag === "confirming") {
      expect(next.response).toBe(nonFinalMed);
      expect(next.outputSlot).toBe("so far");
    } else {
      throw new Error(`expected confirming, got ${next.tag}`);
    }
  });

  test("editing + submit-edit on non-final med → executing-step with edited content", () => {
    const state = makeEditing({ response: nonFinalMed });
    const next = reduce(state, { type: "submit-edit", text: "echo git-stash-u-fake" });
    if (next.tag === "executing-step") {
      expect(next.response.content).toBe("echo git-stash-u-fake");
      expect(next.response.final).toBe(false);
    } else {
      throw new Error(`expected executing-step, got ${next.tag}`);
    }
  });

  test("dialog-open rule: loop-final with final-low from processing → confirming (no auto-exec)", () => {
    const state = makeProcessing();
    const finalLow = makeResponse({ risk_level: "low", final: true, content: "ls" });
    const next = reduce(state, {
      type: "loop-final",
      result: { type: "command", response: finalLow, round: makeRound(finalLow) },
    });
    expect(next.tag).toBe("confirming");
  });
});

describe("reduce — purity and no-op behavior", () => {
  test("same input → same output, called repeatedly", () => {
    const state = makeConfirming();
    const event = { type: "key-action" as const, action: "edit" as const };
    const a = reduce(state, event);
    const b = reduce(state, event);
    expect(a).toEqual(b);
  });

  test("unrelated event in confirming returns state by reference", () => {
    const state = makeConfirming();
    const next = reduce(state, { type: "draft-change", text: "x" });
    expect(next).toBe(state);
  });

  test("unrelated event in thinking returns state by reference", () => {
    const state: AppState = { tag: "thinking" };
    const next = reduce(state, { type: "key-esc" });
    expect(next).toBe(state);
  });

  test("notification kind that the dialog ignores returns state by reference", () => {
    const state = makeConfirming();
    const next = reduce(state, {
      type: "notification",
      notification: { kind: "chrome", text: "during confirming, no slot for this" },
    });
    expect(next).toBe(state);
  });
});
