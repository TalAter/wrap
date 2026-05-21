import { describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import { createLogEntry, type LogEntry, type Turn } from "../src/logging/entry.ts";
import { finaliseOutcome } from "../src/session/session.ts";

function makeEntry(): LogEntry {
  return createLogEntry({
    cwd: "/tmp",
    provider: TEST_RESOLVED_PROVIDER,
    promptHash: "h",
  });
}

function finalTurn(entry: LogEntry): Extract<Turn, { kind: "final" }> | undefined {
  return entry.turns.find((t): t is Extract<Turn, { kind: "final" }> => t.kind === "final");
}

function makeCmd(overrides: Partial<CommandResponse> = {}): CommandResponse {
  return {
    type: "command",
    final: true,
    content: "echo last-proposal",
    risk_level: "low",
    ...overrides,
  } as CommandResponse;
}

describe("finaliseOutcome", () => {
  test("cancel → exit 0 (user-initiated abort is graceful)", async () => {
    const entry = makeEntry();
    const code = await finaliseOutcome({ kind: "cancel" }, entry);
    expect(code).toBe(0);
    expect(entry.outcome).toBe("cancelled");
  });

  test("exhausted → exit 1", async () => {
    const entry = makeEntry();
    const code = await finaliseOutcome({ kind: "exhausted" }, entry);
    expect(code).toBe(1);
    expect(entry.outcome).toBe("max_rounds");
  });

  test("blocked → exit 1", async () => {
    const entry = makeEntry();
    const code = await finaliseOutcome({ kind: "blocked", command: "rm -rf /" }, entry);
    expect(code).toBe(1);
    expect(entry.outcome).toBe("blocked");
  });

  test("answer → exit 0", async () => {
    const entry = makeEntry();
    const code = await finaliseOutcome({ kind: "answer", content: "hi" }, entry);
    expect(code).toBe(0);
    expect(entry.outcome).toBe("success");
  });
});

describe("finaliseOutcome pushes a final turn", () => {
  test("answer → NO final turn (pure-answer sessions skip it)", async () => {
    const entry = makeEntry();
    await finaliseOutcome({ kind: "answer", content: "hi" }, entry);
    expect(finalTurn(entry)).toBeUndefined();
  });

  test("cancel with response → final{source: cancelled, command, exit_code: null}", async () => {
    const entry = makeEntry();
    const response = makeCmd({ content: "git push" });
    await finaliseOutcome({ kind: "cancel", response }, entry);
    const f = finalTurn(entry);
    expect(f?.source).toBe("cancelled");
    expect(f?.command).toBe("git push");
    expect(f?.exit_code).toBeNull();
  });

  test("cancel without response falls back to last assistant turn's command", async () => {
    const entry = makeEntry();
    entry.turns.push({ kind: "user", text: "x" });
    entry.turns.push({
      kind: "assistant",
      response: makeCmd({ content: "echo fallback" }),
      attempts: [],
      source: "model",
    });
    await finaliseOutcome({ kind: "cancel" }, entry);
    expect(finalTurn(entry)?.command).toBe("echo fallback");
  });

  test("blocked → final{source: blocked, command, exit_code: null}", async () => {
    const entry = makeEntry();
    await finaliseOutcome({ kind: "blocked", command: "rm -rf /" }, entry);
    const f = finalTurn(entry);
    expect(f?.source).toBe("blocked");
    expect(f?.command).toBe("rm -rf /");
    expect(f?.exit_code).toBeNull();
  });

  test("exhausted pulls the last LLM-proposed command from the assistant turns", async () => {
    const entry = makeEntry();
    entry.turns.push({ kind: "user", text: "x" });
    entry.turns.push({
      kind: "assistant",
      response: makeCmd({ content: "old proposal", final: false }),
      attempts: [],
      source: "model",
    });
    entry.turns.push({
      kind: "step",
      command: "old proposal",
      exit_code: 0,
      output: "",
      shell: "/bin/sh",
      source: "model",
    });
    entry.turns.push({
      kind: "assistant",
      response: makeCmd({ content: "latest proposal" }),
      attempts: [],
      source: "model",
    });
    await finaliseOutcome({ kind: "exhausted" }, entry);
    const f = finalTurn(entry);
    expect(f?.source).toBe("exhausted");
    expect(f?.command).toBe("latest proposal");
    expect(f?.exit_code).toBeNull();
  });

  test("exhausted with no assistant turn ever produced → empty command", async () => {
    const entry = makeEntry();
    entry.turns.push({ kind: "user", text: "go" });
    await finaliseOutcome({ kind: "exhausted" }, entry);
    expect(finalTurn(entry)?.command).toBe("");
  });

  test("lastProposedCommand walks past reply-typed assistant turns", async () => {
    const entry = makeEntry();
    entry.turns.push({
      kind: "assistant",
      response: makeCmd({ content: "command-bytes", final: false }),
      attempts: [],
      source: "model",
    });
    entry.turns.push({
      kind: "assistant",
      response: { type: "reply", final: true, content: "an answer", risk_level: "low" },
      attempts: [],
      source: "model",
    });
    await finaliseOutcome({ kind: "exhausted" }, entry);
    expect(finalTurn(entry)?.command).toBe("command-bytes");
  });

  test("lastProposedCommand ignores user-override step bytes", async () => {
    // Spec says the final.command for non-exec outcomes is the LLM's last
    // proposal, not what the user actually ran. The intermediate step has
    // user-edited bytes; the assistant turn before it has the model's bytes.
    const entry = makeEntry();
    entry.turns.push({
      kind: "assistant",
      response: makeCmd({ content: "model-bytes", final: false, risk_level: "medium" }),
      attempts: [],
      source: "model",
    });
    entry.turns.push({
      kind: "step",
      command: "user-edited-bytes",
      exit_code: 0,
      output: "",
      shell: "/bin/sh",
      source: "user_override",
    });
    await finaliseOutcome({ kind: "exhausted" }, entry);
    expect(finalTurn(entry)?.command).toBe("model-bytes");
  });

  test("error pushes a final{source: error} turn before throwing", async () => {
    const entry = makeEntry();
    entry.turns.push({
      kind: "assistant",
      response: makeCmd({ content: "would-have-run" }),
      attempts: [],
      source: "model",
    });
    let thrown: unknown;
    try {
      await finaliseOutcome({ kind: "error", message: "boom" }, entry);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const f = finalTurn(entry);
    expect(f?.source).toBe("error");
    expect(f?.command).toBe("would-have-run");
    expect(f?.exit_code).toBeNull();
  });
});
