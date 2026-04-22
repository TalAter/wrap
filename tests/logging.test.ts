import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import {
  addRound,
  createLogEntry,
  type Round,
  scrubApiKey,
  serializeEntry,
} from "../src/logging/entry.ts";
import { appendLogEntry } from "../src/logging/writer.ts";
import { wrap, wrapMock } from "./helpers.ts";

describe("createLogEntry", () => {
  const defaults = {
    prompt: "find all ts files",
    cwd: "/Users/tal/projects",
    provider: { name: "claude-code", model: "haiku" },
    promptHash: "abc123",
  };

  test("generates a valid UUID for id", () => {
    const entry = createLogEntry(defaults);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates an ISO 8601 timestamp", () => {
    const entry = createLogEntry(defaults);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  test("captures prompt, cwd, provider, prompt_hash", () => {
    const entry = createLogEntry(defaults);
    expect(entry.prompt).toBe("find all ts files");
    expect(entry.cwd).toBe("/Users/tal/projects");
    expect(entry.provider).toEqual({ name: "claude-code", model: "haiku" });
    expect(entry.prompt_hash).toBe("abc123");
  });

  test("starts with empty rounds and outcome 'error'", () => {
    const entry = createLogEntry(defaults);
    expect(entry.rounds).toEqual([]);
    expect(entry.outcome).toBe("error");
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
      prompt: "test",
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
      prompt: "test",
      cwd: "/tmp",
      provider: { name: "openai", model: "gpt-4o-mini", apiKey: "ab" },
      promptHash: "abc",
    });
    expect(entry.provider.apiKey).toBe("...");
  });

  test("no apiKey field left unchanged", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { name: "anthropic", model: "haiku" },
      promptHash: "abc",
    });
    expect(entry.provider).toEqual({ name: "anthropic", model: "haiku" });
  });

  test("test sentinel provider unchanged", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    expect(entry.provider).toEqual(TEST_RESOLVED_PROVIDER);
  });
});

describe("addRound", () => {
  test("appends a round to the entry", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    const round: Round = { attempts: [{ raw_response: '{"type":"answer"}' }] };
    addRound(entry, round);
    expect(entry.rounds).toHaveLength(1);
    const saved = entry.rounds[0];
    if (!saved) throw new Error("expected a round");
    expect(saved.attempts[0]?.raw_response).toBe('{"type":"answer"}');
  });

  test("accumulates multiple rounds", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    addRound(entry, {
      attempts: [{ raw_response: "first", error: { kind: "parse", message: "bad json" } }],
    });
    addRound(entry, { attempts: [{ raw_response: '{"type":"command"}' }] });
    expect(entry.rounds).toHaveLength(2);
  });
});

describe("serializeEntry", () => {
  test("produces valid JSON", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    const json = serializeEntry(entry);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("omits undefined fields", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect("attached_input" in parsed).toBe(false);
  });

  test("includes all present fields", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      attachedInputPath: "/tmp/wrap-scratch-abc/input",
      attachedInputSize: 10,
      attachedInputPreview: "stdin data",
      provider: { name: "claude-code", model: "haiku" },
      promptHash: "abc",
    });
    entry.outcome = "success";
    addRound(entry, {
      attempts: [
        {
          parsed: {
            type: "command",
            content: "ls",
            risk_level: "low",
            final: true,
          },
        },
      ],
      execution: { command: "ls", exit_code: 0, shell: "/bin/zsh" },
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect(parsed.attached_input?.preview).toBe("stdin data");
    expect(parsed.outcome).toBe("success");
    expect(parsed.rounds[0].attempts[0].parsed.content).toBe("ls");
    expect(parsed.rounds[0].execution.exit_code).toBe(0);
    expect("raw_response" in parsed.rounds[0].attempts[0]).toBe(false);
  });

  test("omits null-valued attempt fields on parse failure", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    addRound(entry, {
      attempts: [{ raw_response: "garbage", error: { kind: "parse", message: "bad json" } }],
    });
    const parsed = JSON.parse(serializeEntry(entry));
    const attempt = parsed.rounds[0].attempts[0];
    expect("raw_response" in attempt).toBe(true);
    expect(attempt.error.kind).toBe("parse");
    expect("parsed" in attempt).toBe(false);
    expect("execution" in parsed.rounds[0]).toBe(false);
  });

  test("does not contain newlines (single JSONL line)", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
    expect(serializeEntry(entry)).not.toContain("\n");
  });
});

describe("appendLogEntry", () => {
  function makeTmpHome() {
    return mkdtempSync(join(tmpdir(), "wrap-log-test-"));
  }

  function makeEntry() {
    return createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: TEST_RESOLVED_PROVIDER,
      promptHash: "abc",
    });
  }

  test("creates logs directory and file on first write", () => {
    const home = makeTmpHome();
    const entry = makeEntry();
    appendLogEntry(home, entry);
    const logPath = join(home, "logs", "wrap.jsonl");
    expect(existsSync(logPath)).toBe(true);
  });

  test("writes valid JSON on a single line", () => {
    const home = makeTmpHome();
    appendLogEntry(home, makeEntry());
    const content = readFileSync(join(home, "logs", "wrap.jsonl"), "utf-8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (!line) throw new Error("expected a line");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  test("appends multiple entries as separate lines", () => {
    const home = makeTmpHome();
    appendLogEntry(home, makeEntry());
    appendLogEntry(home, makeEntry());
    appendLogEntry(home, makeEntry());
    const content = readFileSync(join(home, "logs", "wrap.jsonl"), "utf-8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("each line has a unique id", () => {
    const home = makeTmpHome();
    appendLogEntry(home, makeEntry());
    appendLogEntry(home, makeEntry());
    const content = readFileSync(join(home, "logs", "wrap.jsonl"), "utf-8");
    const ids = content
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(new Set(ids).size).toBe(2);
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

describe("logging integration", () => {
  test("successful command: outcome, execution, and timing", async () => {
    const result = await wrapMock("list files", {
      type: "command",
      content: "echo hello",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("success");
    expect(entry.prompt).toBe("list files");
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0].attempts.at(-1).parsed.type).toBe("command");
    expect(entry.rounds[0].execution.command).toBe("echo hello");
    expect(entry.rounds[0].execution.exit_code).toBe(0);
    expect(entry.rounds[0].execution.shell).toBe(process.env.SHELL || "sh");
    // Timing
    expect(entry.rounds[0].llm_ms).toBeGreaterThanOrEqual(0);
    expect(entry.rounds[0].exec_ms).toBeGreaterThanOrEqual(0);
  });

  test("successful answer: outcome, fields, timing, no execution", async () => {
    const result = await wrapMock("what is 2+2", {
      type: "reply",
      content: "4",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("success");
    expect(entry.rounds[0].attempts.at(-1).parsed.type).toBe("reply");
    expect(entry.rounds[0].execution).toBeUndefined();
    // Invocation-level fields
    expect(entry.id).toMatch(/^[0-9a-f]{8}-/);
    expect(entry.timestamp).toBeDefined();
    expect(entry.prompt).toBe("what is 2+2");
    expect(entry.cwd).toBeDefined();
    expect(entry.provider).toEqual(TEST_RESOLVED_PROVIDER);
    expect(entry.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.version).toBe("string");
    expect(entry.version.length).toBeGreaterThan(0);
    // Timing: llm_ms present, exec_ms absent
    expect(entry.rounds[0].llm_ms).toBeGreaterThanOrEqual(0);
    expect(typeof entry.rounds[0].llm_ms).toBe("number");
    expect("exec_ms" in entry.rounds[0]).toBe(false);
    // Successful parse omits raw_response
    expect(entry.rounds[0].attempts.at(-1).parsed).toBeDefined();
    expect("raw_response" in entry.rounds[0].attempts.at(-1)).toBe(false);
  });

  test("empty content logs with outcome 'error'", async () => {
    const result = await wrapMock("what is 2+2", {
      type: "reply",
      content: "",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("error");
    expect(entry.rounds[0].attempts.at(-1).parsed.type).toBe("reply");
  });

  test("parse error logs provider_error", async () => {
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
    expect(entry.rounds).toHaveLength(1);
    // The test provider throws a raw JSON SyntaxError from its own JSON.parse,
    // which is not recognized as a structured-output error by the retry
    // ladder — so it surfaces on the first attempt as a provider-kind error.
    const firstAttempt = entry.rounds[0].attempts[0];
    expect(firstAttempt.error.kind).toBe("provider");
    expect(firstAttempt.error.message).toBeDefined();
  });

  test("non-low risk command logs with outcome 'blocked' (no TTY)", async () => {
    const result = await wrapMock("delete everything", {
      type: "command",
      content: "echo rm-rf-fake",
      risk_level: "high",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("blocked");
    expect(entry.rounds[0].attempts.at(-1).parsed.content).toBe("echo rm-rf-fake");
    expect(entry.rounds[0].execution).toBeUndefined();
  });

  test("command with non-zero exit code logs outcome 'error'", async () => {
    const result = await wrapMock("fail", {
      type: "command",
      content: "exit 1",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("error");
    expect(entry.rounds[0].execution.exit_code).toBe(1);
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

describe("scrubApiKey", () => {
  test("replaces the key with ...XXXX inside nested strings", () => {
    const secret = "sk-ant-api03-SECRETSENTINEL-1234";
    const body = {
      headers: { authorization: `Bearer ${secret}` },
      nested: [{ leak: secret }],
      unrelated: "hello",
    };
    const scrubbed = scrubApiKey(body, secret);
    const json = JSON.stringify(scrubbed);
    expect(json.includes(secret)).toBe(false);
    expect(json).toContain("...1234");
    expect(scrubbed.unrelated).toBe("hello");
  });

  test("returns input unchanged when apiKey is undefined", () => {
    const body = { keep: "me" };
    expect(scrubApiKey(body, undefined)).toBe(body);
  });

  test("skips short keys to avoid accidental matches on common noise", () => {
    const body = { msg: "a short key ab here" };
    // 2-char key "ab" is under the 8-char threshold; leave it alone.
    expect(scrubApiKey(body, "ab")).toBe(body);
  });

  test("redacts an exactly-8-char key (boundary)", () => {
    const secret = "SeKret!8";
    const body = { leak: `auth ${secret} tail` };
    const scrubbed = scrubApiKey(body, secret);
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
  });

  test("preserves arrays as arrays (not coerced to objects)", () => {
    const secret = "sk-secret-12345678";
    const body = { arr: [secret, "ok"] };
    const scrubbed = scrubApiKey(body, secret);
    expect(Array.isArray(scrubbed.arr)).toBe(true);
  });

  test("preserves primitive values (numbers, booleans)", () => {
    const secret = "sk-secret-12345678";
    const body = { n: 42, b: true };
    const scrubbed = scrubApiKey(body, secret);
    expect(scrubbed.n).toBe(42);
    expect(scrubbed.b).toBe(true);
  });
});

describe("log traces — default off", () => {
  test("successful round omits request/request_wire/response_wire", async () => {
    const result = await wrapMock("list files", {
      type: "command",
      content: "echo hi",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    const attempt = entry.rounds[0].attempts.at(-1);
    expect("request" in attempt).toBe(false);
    expect("request_wire" in attempt).toBe(false);
    expect("response_wire" in attempt).toBe(false);
    // raw_response still omitted on successful parse
    expect("raw_response" in attempt).toBe(false);
  });
});

describe("log traces — enabled", () => {
  test("successful round captures request + wire + raw_response", async () => {
    const result = await wrapMock(
      "list files",
      { type: "command", content: "echo hi", risk_level: "low" },
      { logTraces: true },
    );
    const entry = readLog(result.wrapHome);
    const attempt = entry.rounds[0].attempts.at(-1);
    expect(attempt.request).toBeDefined();
    expect(attempt.request.system).toBeDefined();
    expect(Array.isArray(attempt.request.messages)).toBe(true);
    expect(attempt.request_wire).toBeDefined();
    expect(attempt.request_wire.kind).toBe("test");
    expect(attempt.response_wire).toBeDefined();
    expect(attempt.response_wire.kind).toBe("test");
    // raw_response becomes always-on when logTraces is on
    expect(typeof attempt.raw_response).toBe("string");
  });
});
