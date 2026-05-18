import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import { createLogEntry, type LogEntry, serializeEntry } from "../src/logging/entry.ts";
import {
  assembleContinuationChain,
  findContinuationParent,
  readLogEntries,
} from "../src/logging/lookup.ts";

const defaults = {
  cwd: "/Users/tal/projects",
  provider: TEST_RESOLVED_PROVIDER,
  promptHash: "abc123",
};

function home(): string {
  return mkdtempSync(join(tmpdir(), "wrap-lookup-"));
}

function writeLog(wrapHome: string, entries: LogEntry[]): void {
  mkdirSync(join(wrapHome, "logs"), { recursive: true });
  const path = join(wrapHome, "logs", "wrap.jsonl");
  const body = entries.length === 0 ? "" : `${entries.map(serializeEntry).join("\n")}\n`;
  writeFileSync(path, body);
}

function mkEntry(overrides: Partial<LogEntry>): LogEntry {
  return { ...createLogEntry(defaults), ...overrides };
}

describe("readLogEntries", () => {
  test("returns [] when no log file exists", () => {
    expect(readLogEntries(home())).toEqual([]);
  });

  test("returns [] for an empty log file", () => {
    const wrapHome = home();
    writeLog(wrapHome, []);
    expect(readLogEntries(wrapHome)).toEqual([]);
  });

  test("skips malformed JSON lines silently", () => {
    const wrapHome = home();
    mkdirSync(join(wrapHome, "logs"), { recursive: true });
    const path = join(wrapHome, "logs", "wrap.jsonl");
    const good = mkEntry({ id: "good" });
    writeFileSync(path, `garbage\n${serializeEntry(good)}\ntrash\n`);
    const entries = readLogEntries(wrapHome);
    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });
});

describe("findContinuationParent", () => {
  test("returns null when entries are empty", () => {
    expect(findContinuationParent([], 1234)).toBeNull();
  });

  test("returns newest entry when no ppid match (fallback)", () => {
    const older = mkEntry({ id: "older", ppid: 1111 });
    const newer = mkEntry({ id: "newer", ppid: 2222 });
    expect(findContinuationParent([older, newer], 9999)?.id).toBe("newer");
  });

  test("returns newest entry whose ppid matches", () => {
    const a = mkEntry({ id: "a", ppid: 1111 });
    const b = mkEntry({ id: "b", ppid: 2222 });
    const c = mkEntry({ id: "c", ppid: 1111 });
    const d = mkEntry({ id: "d", ppid: 3333 });
    expect(findContinuationParent([a, b, c, d], 1111)?.id).toBe("c");
  });

  test("ppid === 1 falls through to newest entry (orphaned process)", () => {
    const a = mkEntry({ id: "a", ppid: 1 });
    const b = mkEntry({ id: "b", ppid: 5555 });
    // Caller's PPID is 1 — must NOT match the entry with ppid=1; fall through.
    expect(findContinuationParent([a, b], 1)?.id).toBe("b");
  });

  test("prefers a ppid match even when a newer non-matching entry exists", () => {
    const match = mkEntry({ id: "ppid-match", ppid: 7777 });
    const newer = mkEntry({ id: "newer-other", ppid: 8888 });
    expect(findContinuationParent([match, newer], 7777)?.id).toBe("ppid-match");
  });
});

describe("assembleContinuationChain", () => {
  test("single-entry chain returns the parent's turns", () => {
    const parent = mkEntry({
      id: "p",
      turns: [
        { kind: "user", text: "deploy this" },
        { kind: "assistant", attempts: [] },
      ],
    });
    const assembled = assembleContinuationChain([parent], parent);
    expect(assembled.map((t) => t.kind)).toEqual(["user", "assistant"]);
  });

  test("walks parent_id chain root-first across multiple entries", () => {
    const root = mkEntry({
      id: "root",
      turns: [{ kind: "user", text: "root prompt" }],
    });
    const mid = mkEntry({
      id: "mid",
      parent_id: "root",
      turns: [{ kind: "user", text: "mid prompt" }],
    });
    const parent = mkEntry({
      id: "parent",
      parent_id: "mid",
      turns: [{ kind: "user", text: "parent prompt" }],
    });
    const assembled = assembleContinuationChain([root, mid, parent], parent);
    const texts = assembled
      .filter((t): t is { kind: "user"; text: string } => t.kind === "user")
      .map((t) => t.text);
    expect(texts).toEqual(["root prompt", "mid prompt", "parent prompt"]);
  });

  test("missing parent_id link truncates the chain without crashing", () => {
    const parent = mkEntry({
      id: "p",
      parent_id: "ghost",
      turns: [{ kind: "user", text: "child" }],
    });
    expect(assembleContinuationChain([parent], parent)).toEqual([{ kind: "user", text: "child" }]);
  });
});
