import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/resolve-provider.ts";
import { createLogEntry, serializeEntry } from "../src/logging/entry.ts";
import { appendLogEntry } from "../src/logging/writer.ts";
import { wrap, wrapMock } from "./helpers.ts";
import { TEST_HOME as UNIT_TEST_HOME } from "./wrap-home-preload.ts";

const defaults = {
  cwd: "/Users/tal/projects",
  provider: { name: "claude-code", model: "haiku" },
  promptHash: "abc123",
};

describe("createLogEntry", () => {
  test("generates a valid UUID for id", () => {
    const entry = createLogEntry(defaults);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates an ISO 8601 timestamp", () => {
    const entry = createLogEntry(defaults);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  test("captures cwd, provider, prompt_hash", () => {
    const entry = createLogEntry(defaults);
    expect(entry.cwd).toBe("/Users/tal/projects");
    expect(entry.provider).toEqual({ name: "claude-code", model: "haiku" });
    expect(entry.prompt_hash).toBe("abc123");
  });

  test("starts with empty turns and outcome 'error'", () => {
    const entry = createLogEntry(defaults);
    expect(entry.turns).toEqual([]);
    expect(entry.outcome).toBe("error");
  });

  test("stamps ppid from process.ppid by default", () => {
    const entry = createLogEntry(defaults);
    expect(entry.ppid).toBe(process.ppid);
  });

  test("ppid override takes precedence (for tests)", () => {
    const entry = createLogEntry({ ...defaults, ppid: 4242 });
    expect(entry.ppid).toBe(4242);
  });

  test("parent_id is absent by default", () => {
    const entry = createLogEntry(defaults);
    expect("parent_id" in entry).toBe(false);
  });

  test("includes version string", () => {
    const entry = createLogEntry(defaults);
    expect(typeof entry.version).toBe("string");
    expect(entry.version.length).toBeGreaterThan(0);
  });

  test("includes attached_input when provided", () => {
    const entry = createLogEntry({
      ...defaults,
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 11,
      attachedInputPreview: "hello world",
    });
    expect(entry.attached_input?.path).toBe("/tmp/wrap-scratch-abc/input");
    expect(entry.attached_input?.size).toBe(11);
    expect(entry.attached_input?.preview).toBe("hello world");
  });

  test("truncates attached_input preview to 1000 chars in log", () => {
    const long = "x".repeat(5000);
    const entry = createLogEntry({
      ...defaults,
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 5000,
      attachedInputPreview: long,
    });
    expect(entry.attached_input?.preview).toHaveLength(
      1000 + "\n[…truncated, 5000 chars total]".length,
    );
    expect(entry.attached_input?.preview).toStartWith("x".repeat(1000));
    expect(entry.attached_input?.preview).toEndWith("[…truncated, 5000 chars total]");
  });

  test("does not truncate attached_input preview at exactly 1000 chars", () => {
    const exact = "x".repeat(1000);
    const entry = createLogEntry({
      ...defaults,
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 1000,
      attachedInputPreview: exact,
    });
    expect(entry.attached_input?.preview).toBe(exact);
  });

  test("omits attached_input when not provided", () => {
    const entry = createLogEntry(defaults);
    expect("attached_input" in entry).toBe(false);
  });

  test("includes memory when provided", () => {
    const memory = { "/": [{ fact: "macOS" }], "/Users/tal": [{ fact: "uses bun" }] };
    const entry = createLogEntry({ ...defaults, memory });
    expect(entry.memory).toEqual(memory);
  });

  test("omits memory when empty", () => {
    const entry = createLogEntry({ ...defaults, memory: {} });
    expect("memory" in entry).toBe(false);
  });

  test("omits memory when not provided", () => {
    const entry = createLogEntry(defaults);
    expect("memory" in entry).toBe(false);
  });
});

describe("createLogEntry redacts apiKey", () => {
  test("redacts apiKey to last 4 chars", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: {
        name: "anthropic",
        model: "claude-haiku-4-5",
        apiKey: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx-abcd",
      },
      promptHash: "abc",
    });
    expect(entry.provider.apiKey).toBe("...abcd");
  });

  test("fully masks keys shorter than 4 chars", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: { name: "openai", model: "gpt-4o-mini", apiKey: "ab" },
      promptHash: "abc",
    });
    expect(entry.provider.apiKey).toBe("...");
  });

  test("no apiKey field left unchanged", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: { name: "anthropic", model: "haiku" },
      promptHash: "abc",
    });
    expect(entry.provider).toEqual({ name: "anthropic", model: "haiku" });
  });

  test("test sentinel provider unchanged", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    expect(entry.provider).toEqual(TEST_RESOLVED_PROVIDER);
  });
});

describe("turns push directly onto entry.turns", () => {
  test("appends a user turn", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    entry.turns.push({ kind: "user", text: "find all ts files" });
    expect(entry.turns).toHaveLength(1);
    const first = entry.turns[0];
    if (first?.kind !== "user") throw new Error("expected a user turn");
    expect(first.text).toBe("find all ts files");
  });

  test("accumulates user + assistant + step turns", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    entry.turns.push({ kind: "user", text: "list files" });
    entry.turns.push({
      kind: "assistant",
      response: { type: "command", content: "ls", risk_level: "low", final: true },
      attempts: [{ llm_ms: 12 }],
      llm_ms: 12,
      source: "model",
    });
    entry.turns.push({
      kind: "final",
      command: "ls",
      exit_code: 0,
      shell: "/bin/zsh",
      source: "model",
      exec_ms: 4,
    });
    expect(entry.turns.map((t) => t.kind)).toEqual(["user", "assistant", "final"]);
  });
});

describe("serializeEntry", () => {
  test("produces valid JSON", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    const json = serializeEntry(entry);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("omits undefined fields", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect("attached_input" in parsed).toBe(false);
    expect("parent_id" in parsed).toBe(false);
  });

  test("includes all present fields", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 10,
      attachedInputPreview: "stdin data",
      provider: { name: "claude-code", model: "haiku" },
      promptHash: "abc",
    });
    entry.outcome = "success";
    entry.turns.push({ kind: "user", text: "list" });
    entry.turns.push({
      kind: "assistant",
      response: { type: "command", content: "ls", risk_level: "low", final: true },
      attempts: [{ llm_ms: 5 }],
      llm_ms: 5,
      source: "model",
    });
    entry.turns.push({
      kind: "final",
      command: "ls",
      exit_code: 0,
      shell: "/bin/zsh",
      source: "model",
      exec_ms: 3,
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect(parsed.attached_input?.preview).toBe("stdin data");
    expect(parsed.outcome).toBe("success");
    expect(parsed.turns[1].response.content).toBe("ls");
    expect(parsed.turns[2].command).toBe("ls");
    expect(parsed.turns[2].exit_code).toBe(0);
  });

  test("omits null-valued attempt fields on parse failure", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    entry.turns.push({
      kind: "assistant",
      attempts: [{ raw_response: "garbage", error: { kind: "parse", message: "bad json" } }],
      source: "model",
    });
    const parsed = JSON.parse(serializeEntry(entry));
    const turn = parsed.turns[0];
    expect("response" in turn).toBe(false);
    expect(turn.attempts[0].raw_response).toBe("garbage");
    expect(turn.attempts[0].error.kind).toBe("parse");
  });

  test("does not contain newlines (single JSONL line)", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    expect(serializeEntry(entry)).not.toContain("\n");
  });

  test("ppid is preserved in the serialized JSON", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
      ppid: 4242,
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect(parsed.ppid).toBe(4242);
  });

  test("assistant turn source round-trips through serialize", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    entry.turns.push({
      kind: "assistant",
      response: { type: "command", content: "ls", risk_level: "low", final: true },
      attempts: [],
      source: "model",
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect(parsed.turns[0].source).toBe("model");
  });

  test("response-less assistant turn (fully-failed round) is preserved in JSONL", () => {
    const entry = createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    entry.turns.push({
      kind: "assistant",
      attempts: [
        { error: { kind: "provider", message: "rate limit" }, llm_ms: 12 },
        { error: { kind: "parse", message: "bad json" }, raw_response: "oops" },
      ],
      source: "model",
    });
    const parsed = JSON.parse(serializeEntry(entry));
    const turn = parsed.turns[0];
    expect(turn.kind).toBe("assistant");
    expect("response" in turn).toBe(false);
    expect(turn.attempts).toHaveLength(2);
    expect(turn.attempts[0].error.message).toBe("rate limit");
    expect(turn.attempts[1].raw_response).toBe("oops");
  });
});

describe("appendLogEntry", () => {
  // appendLogEntry writes under UNIT_TEST_HOME (the singleton set at file
  // top). Wipe `logs/` between tests so each starts from an empty state.
  const LOGS_DIR = join(UNIT_TEST_HOME, "logs");

  beforeEach(() => {
    rmSync(LOGS_DIR, { recursive: true, force: true });
  });

  function makeEntry() {
    return createLogEntry({
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
  }

  test("creates logs directory and file on first write", () => {
    appendLogEntry(makeEntry());
    expect(existsSync(join(LOGS_DIR, "wrap.jsonl"))).toBe(true);
  });

  test("writes valid JSON on a single line", () => {
    appendLogEntry(makeEntry());
    const content = readFileSync(join(LOGS_DIR, "wrap.jsonl"), "utf-8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (!line) throw new Error("expected a line");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  test("appends multiple entries as separate lines", () => {
    appendLogEntry(makeEntry());
    appendLogEntry(makeEntry());
    appendLogEntry(makeEntry());
    const content = readFileSync(join(LOGS_DIR, "wrap.jsonl"), "utf-8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("each line has a unique id", () => {
    appendLogEntry(makeEntry());
    appendLogEntry(makeEntry());
    const content = readFileSync(join(LOGS_DIR, "wrap.jsonl"), "utf-8");
    const ids = content
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(new Set(ids).size).toBe(2);
  });

  test("trace sidecar keys turn_attempts by the assistant turn's actual index", () => {
    // Sanity that the writer doesn't off-by-one when non-assistant turns come
    // first/in-between. Two user turns + an assistant + a step + another
    // assistant: the traced indices must be 2 and 4, not 0 and 1.
    const entry = makeEntry();
    entry.turns.push({ kind: "user", text: "first" });
    entry.turns.push({ kind: "user", text: "second" });
    entry.turns.push({
      kind: "assistant",
      attempts: [{ request_wire: { kind: "test" } }],
      source: "model",
    });
    entry.turns.push({
      kind: "step",
      command: "echo x",
      exit_code: 0,
      output: "",
      shell: "/bin/sh",
      source: "model",
    });
    entry.turns.push({
      kind: "assistant",
      attempts: [{ request_wire: { kind: "test" } }],
      source: "model",
    });
    appendLogEntry(entry);
    const trace = JSON.parse(readFileSync(join(LOGS_DIR, "traces", `${entry.id}.json`), "utf-8"));
    expect(Object.keys(trace.turn_attempts).sort()).toEqual(["2", "4"]);
  });

  test("sidecar failure does not block jsonl append", () => {
    mkdirSync(LOGS_DIR);
    // Block sidecar by occupying its parent path with a file.
    writeFileSync(join(LOGS_DIR, "traces"), "");

    const entry = makeEntry();
    entry.turns.push({
      kind: "assistant",
      attempts: [{ request_wire: { kind: "test" } }],
      source: "model",
    });

    expect(() => appendLogEntry(entry)).toThrow();

    const content = readFileSync(join(LOGS_DIR, "wrap.jsonl"), "utf-8").trim();
    expect(JSON.parse(content).id).toBe(entry.id);
  });
});

function readLogEntries(wrapHome: string) {
  return readFileSync(join(wrapHome, "logs", "wrap.jsonl"), "utf-8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function readLog(wrapHome: string) {
  const entries = readLogEntries(wrapHome);
  return entries[entries.length - 1];
}

function seedMemoryIn(home: string) {
  writeFileSync(join(home, "memory.json"), '{"/":[{"fact":"test"}]}');
}

/** Pull the first / nth turn of a given kind (skips probe turns). */
function turnOfKind<K extends string>(
  entry: { turns: { kind: string }[] },
  kind: K,
  index = 0,
): Record<string, unknown> | undefined {
  const matches = entry.turns.filter((t) => t.kind === kind);
  return matches[index] as Record<string, unknown> | undefined;
}

/** Turn kinds with probe turns stripped — for tests that pin the
 * structural sequence of model + final turns. */
function modelTurnKinds(entry: { turns: { kind: string }[] }): string[] {
  return entry.turns.filter((t) => t.kind !== "probe").map((t) => t.kind);
}

describe("logging integration", () => {
  test("successful command: outcome, turns, final-turn execution, and timing", async () => {
    const result = await wrapMock("list files", {
      type: "command",
      content: "echo hello",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("success");
    // user → assistant → final (skill turns filtered out)
    expect(modelTurnKinds(entry)).toEqual(["user", "assistant", "final"]);
    const userTurn = turnOfKind(entry, "user");
    expect(userTurn?.text).toBe("list files");
    const assistant = turnOfKind(entry, "assistant");
    expect((assistant?.response as { type: string }).type).toBe("command");
    expect(assistant?.llm_ms).toBeGreaterThanOrEqual(0);
    const final = turnOfKind(entry, "final");
    expect(final?.command).toBe("echo hello");
    expect(final?.exit_code).toBe(0);
    expect(final?.shell).toBe(process.env.SHELL || "sh");
    expect(final?.source).toBe("model");
    expect(final?.exec_ms).toBeGreaterThanOrEqual(0);
  });

  test("successful answer: no final turn; assistant carries the reply", async () => {
    const result = await wrapMock("what is 2+2", {
      type: "reply",
      content: "4",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("success");
    expect(modelTurnKinds(entry)).toEqual(["user", "assistant"]);
    const assistant = turnOfKind(entry, "assistant");
    expect((assistant?.response as { type: string }).type).toBe("reply");
    // Invocation-level fields
    expect(entry.id).toMatch(/^[0-9a-f]{8}-/);
    expect(entry.timestamp).toBeDefined();
    expect(entry.cwd).toBeDefined();
    expect(entry.provider).toEqual(TEST_RESOLVED_PROVIDER);
    expect(entry.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.version).toBe("string");
    expect(entry.version.length).toBeGreaterThan(0);
    expect(entry.ppid).toBeNumber();
    // Timing: llm_ms on the assistant turn
    expect(assistant?.llm_ms).toBeGreaterThanOrEqual(0);
    // Successful parse omits raw_response on the attempt
    const attempt = (assistant?.attempts as { raw_response?: string }[])[0];
    expect("raw_response" in (attempt ?? {})).toBe(false);
  });

  test("empty content logs with outcome 'error'", async () => {
    const result = await wrapMock("what is 2+2", {
      type: "reply",
      content: "",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("error");
    // The assistant turn carries the empty response on its attempt's error.
    const assistant = turnOfKind(entry, "assistant");
    const attempts = assistant?.attempts as { error?: { kind: string } }[];
    expect(attempts[0]?.error?.kind).toBe("empty");
  });

  test("parse error logs two parse-kind attempts (the send's one retry)", async () => {
    const home = mkdtempSync(join(tmpdir(), "wrap-log-test-"));
    seedMemoryIn(home);
    const result = await wrap("test prompt", {
      WRAP_HOME: home,
      WRAP_CONFIG: JSON.stringify({}),
      WRAP_TEST_RESPONSE: "not json at all",
    });
    expect(result.exitCode).not.toBe(0);
    const entry = readLog(home);
    expect(entry.outcome).toBe("error");
    const assistant = turnOfKind(entry, "assistant");
    expect(assistant).toBeDefined();
    // Core classifies the unparsable canned response and retries once inside
    // the send: two physical attempts, both parse-kind, each carrying the
    // raw text breadcrumb. (Pre-flip this surfaced as ONE provider-kind
    // attempt because the legacy test provider parsed its own output —
    // contract shift sanctioned by the promotion spec.)
    const attempts = assistant?.attempts as {
      error?: { kind: string; message?: string };
      raw_response?: string;
    }[];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.error?.kind).toBe("parse");
    expect(attempts[1]?.error?.kind).toBe("parse");
    expect(attempts[0]?.raw_response).toBe("not json at all");
    expect(attempts[0]?.error?.message).toBeDefined();
  });

  test("scratchpad retry flow merges both sends into ONE assistant turn", async () => {
    // The on-disk JSONL schema stays stable across the core flip: the
    // domain retry's two sends (echo-rejected first response + the filled
    // retry) land as a single assistant turn with two attempts.
    const rejected = {
      _scratchpad: null,
      type: "command",
      content: "echo rm-rf-fake",
      risk_level: "high",
    };
    const filled = { ...rejected, _scratchpad: "Deliberate destruction." };
    const result = await wrapMock("nuke it", [rejected, filled]);
    const entry = readLog(result.wrapHome);
    // High risk + no TTY → blocked; still exactly one assistant turn.
    expect(entry.outcome).toBe("blocked");
    expect(modelTurnKinds(entry)).toEqual(["user", "assistant", "final"]);
    const assistant = turnOfKind(entry, "assistant");
    const attempts = assistant?.attempts as { parsed?: { _scratchpad?: string | null } }[];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.parsed?._scratchpad).toBeNull();
    expect((assistant?.response as { _scratchpad?: string })._scratchpad).toBe(
      "Deliberate destruction.",
    );
  });

  test("non-low risk command logs with outcome 'blocked' (no TTY)", async () => {
    const result = await wrapMock("delete everything", {
      type: "command",
      content: "echo rm-rf-fake",
      risk_level: "high",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("blocked");
    const assistant = turnOfKind(entry, "assistant");
    expect((assistant?.response as { content: string }).content).toBe("echo rm-rf-fake");
    const final = turnOfKind(entry, "final");
    expect(final?.source).toBe("blocked");
    expect(final?.command).toBe("echo rm-rf-fake");
    expect(final?.exit_code).toBeNull();
  });

  test("command with non-zero exit code logs outcome 'error' and final exit_code", async () => {
    const result = await wrapMock("fail", {
      type: "command",
      content: "exit 1",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("error");
    const final = turnOfKind(entry, "final");
    expect(final?.exit_code).toBe(1);
  });

  test("logs memory state from invocation", async () => {
    const result = await wrapMock("test", {
      type: "reply",
      content: "ok",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.memory).toEqual({ "/": [{ fact: "test" }] });
  });
});

describe("log traces — default off", () => {
  test("successful round omits request/request_wire/response_wire on the assistant attempt", async () => {
    const result = await wrapMock("list files", {
      type: "command",
      content: "echo hi",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    const assistant = turnOfKind(entry, "assistant");
    const attempt = (assistant?.attempts as Record<string, unknown>[])[0] ?? {};
    expect("request" in attempt).toBe(false);
    expect("request_wire" in attempt).toBe(false);
    expect("response_wire" in attempt).toBe(false);
    // raw_response still omitted on successful parse
    expect("raw_response" in attempt).toBe(false);
  });
});

describe("log traces — enabled", () => {
  test("trace fields go to sidecar keyed by turn index; entry stays lean", async () => {
    const result = await wrapMock(
      "list files",
      { type: "command", content: "echo hi", risk_level: "low" },
      { logTraces: true },
    );
    const entry = readLog(result.wrapHome);
    const assistant = turnOfKind(entry, "assistant");
    const attempt = (assistant?.attempts as Record<string, unknown>[])[0] ?? {};
    expect("request" in attempt).toBe(false);
    expect("request_wire" in attempt).toBe(false);
    expect("response_wire" in attempt).toBe(false);
    expect("raw_response" in attempt).toBe(false);

    const tracePath = join(result.wrapHome, "logs", "traces", `${entry.id}.json`);
    expect(existsSync(tracePath)).toBe(true);
    const trace = JSON.parse(readFileSync(tracePath, "utf-8"));
    expect(trace.entry_id).toBe(entry.id);
    // Only the model assistant has traced attempts; skill assistants have
    // empty attempt arrays and are skipped by the trace extractor.
    const tracedKeys = Object.keys(trace.turn_attempts);
    expect(tracedKeys).toHaveLength(1);
    const traced = trace.turn_attempts[tracedKeys[0] as string][0];
    expect(traced.request).toBeDefined();
    expect(traced.request.system).toBeDefined();
    expect(Array.isArray(traced.request.messages)).toBe(true);
    expect(traced.request_wire.kind).toBe("test");
    expect(traced.response_wire.kind).toBe("test");
    expect(typeof traced.raw_response).toBe("string");
  });

  test("no sidecar written when logTraces is off", async () => {
    const result = await wrapMock("list files", {
      type: "command",
      content: "echo hi",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    const tracePath = join(result.wrapHome, "logs", "traces", `${entry.id}.json`);
    expect(existsSync(tracePath)).toBe(false);
  });
});
