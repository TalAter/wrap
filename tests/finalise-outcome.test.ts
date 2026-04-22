import { describe, expect, test } from "bun:test";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import { createLogEntry, type LogEntry } from "../src/logging/entry.ts";
import { finaliseOutcome } from "../src/session/session.ts";

function makeEntry(): LogEntry {
  return createLogEntry({
    prompt: "x",
    cwd: "/tmp",
    provider: TEST_RESOLVED_PROVIDER,
    promptHash: "h",
  });
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
