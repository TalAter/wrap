import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRound, createLogEntry, type Round, serializeEntry } from "../src/logging/entry.ts";
import { appendLogEntry } from "../src/logging/writer.ts";
import { wrap, wrapMock } from "./helpers.ts";

describe("createLogEntry", () => {
  const defaults = {
    prompt: "find all ts files",
    cwd: "/Users/tal/projects",
    provider: { type: "claude-code" as const, model: "haiku" },
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
    expect(entry.provider).toEqual({ type: "claude-code", model: "haiku" });
    expect(entry.prompt_hash).toBe("abc123");
  });

  test("starts with empty rounds and outcome 'error'", () => {
    const entry = createLogEntry(defaults);
    expect(entry.rounds).toEqual([]);
    expect(entry.outcome).toBe("error");
  });

  test("includes piped_input when provided", () => {
    const entry = createLogEntry({ ...defaults, pipedInput: "hello world" });
    expect(entry.piped_input).toBe("hello world");
  });

  test("omits piped_input when not provided", () => {
    const entry = createLogEntry(defaults);
    expect("piped_input" in entry).toBe(false);
  });
});

describe("addRound", () => {
  test("appends a round to the entry", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { type: "test" },
      promptHash: "abc",
    });
    const round: Round = { raw_response: '{"type":"answer"}' };
    addRound(entry, round);
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0].raw_response).toBe('{"type":"answer"}');
  });

  test("accumulates multiple rounds", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { type: "test" },
      promptHash: "abc",
    });
    addRound(entry, { raw_response: "first", parse_error: "bad json" });
    addRound(entry, { raw_response: '{"type":"command"}' });
    expect(entry.rounds).toHaveLength(2);
  });
});

describe("serializeEntry", () => {
  test("produces valid JSON", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { type: "test" },
      promptHash: "abc",
    });
    const json = serializeEntry(entry);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("omits undefined fields", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { type: "test" },
      promptHash: "abc",
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect("piped_input" in parsed).toBe(false);
  });

  test("includes all present fields", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      pipedInput: "stdin data",
      provider: { type: "claude-code", model: "haiku" },
      promptHash: "abc",
    });
    entry.outcome = "success";
    addRound(entry, {
      raw_response: '{"type":"command","command":"ls"}',
      parsed: {
        type: "command",
        command: "ls",
        risk_level: "low",
      },
      execution: { command: "ls", exit_code: 0 },
    });
    const parsed = JSON.parse(serializeEntry(entry));
    expect(parsed.piped_input).toBe("stdin data");
    expect(parsed.outcome).toBe("success");
    expect(parsed.rounds[0].parsed.command).toBe("ls");
    expect(parsed.rounds[0].execution.exit_code).toBe(0);
  });

  test("omits null-valued round fields", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { type: "test" },
      promptHash: "abc",
    });
    addRound(entry, { raw_response: "garbage", parse_error: "bad json" });
    const parsed = JSON.parse(serializeEntry(entry));
    const round = parsed.rounds[0];
    expect("raw_response" in round).toBe(true);
    expect("parse_error" in round).toBe(true);
    expect("parsed" in round).toBe(false);
    expect("execution" in round).toBe(false);
    expect("provider_error" in round).toBe(false);
  });

  test("does not contain newlines (single JSONL line)", () => {
    const entry = createLogEntry({
      prompt: "test",
      cwd: "/tmp",
      provider: { type: "test" },
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
      provider: { type: "test" },
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
    expect(() => JSON.parse(lines[0])).not.toThrow();
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

function readLog(wrapHome: string) {
  return JSON.parse(readFileSync(join(wrapHome, "logs", "wrap.jsonl"), "utf-8").trim());
}

function seedMemoryIn(home: string) {
  writeFileSync(join(home, "memory.json"), '[{"fact":"test"}]');
}

describe("logging integration", () => {
  test("successful command logs with outcome 'success' and execution", async () => {
    const result = await wrapMock("list files", {
      type: "command",
      command: "echo hello",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("success");
    expect(entry.prompt).toBe("list files");
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0].parsed.type).toBe("command");
    expect(entry.rounds[0].execution.command).toBe("echo hello");
    expect(entry.rounds[0].execution.exit_code).toBe(0);
  });

  test("answer logs with outcome 'success' and no execution", async () => {
    const result = await wrapMock("what is 2+2", {
      type: "answer",
      answer: "4",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("success");
    expect(entry.rounds[0].parsed.type).toBe("answer");
    expect(entry.rounds[0].execution).toBeUndefined();
  });

  test("parse error logs raw_response and parse_error", async () => {
    const home = mkdtempSync(join(tmpdir(), "wrap-log-test-"));
    seedMemoryIn(home);
    const result = await wrap("test prompt", {
      WRAP_HOME: home,
      WRAP_CONFIG: JSON.stringify({ provider: { type: "test" } }),
      WRAP_TEST_RESPONSE: "not json at all",
    });
    expect(result.exitCode).not.toBe(0);
    const entry = readLog(home);
    expect(entry.outcome).toBe("error");
    expect(entry.rounds).toHaveLength(1);
    expect(entry.rounds[0].raw_response).toBe("not json at all");
    expect(entry.rounds[0].parse_error).toBeDefined();
  });

  test("log entry has invocation-level fields", async () => {
    const result = await wrapMock("test prompt", {
      type: "answer",
      answer: "ok",
      risk_level: "low",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-/);
    expect(entry.timestamp).toBeDefined();
    expect(entry.prompt).toBe("test prompt");
    expect(entry.cwd).toBeDefined();
    expect(entry.provider).toEqual({ type: "test" });
    expect(entry.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("non-low risk command logs with outcome 'error'", async () => {
    const result = await wrapMock("delete everything", {
      type: "command",
      command: "rm -rf /",
      risk_level: "high",
    });
    const entry = readLog(result.wrapHome);
    expect(entry.outcome).toBe("error");
    expect(entry.rounds[0].parsed.command).toBe("rm -rf /");
    expect(entry.rounds[0].execution).toBeUndefined();
  });
});
