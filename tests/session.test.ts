/**
 * Coordinator integration tests using the test provider stub.
 *
 * These exercise `runSession` with mocked stdin/stdout/stderr where needed.
 * The dialog itself is unit-tested in `dialog.test.tsx`; here we go end-to-end
 * — but we drive interactions by injecting key events into the Ink stdin
 * stream and observing the resulting outcome.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import type { Provider } from "../src/llm/types.ts";
import { resetDialogHostCache } from "../src/session/dialog-host.ts";
import { runSession } from "../src/session/session.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

let stderr: MockStderr;
let tmpHome: string;
let originalConsoleLog: typeof console.log;
let stdoutLines: string[];

beforeEach(() => {
  stderr = mockStderr();
  tmpHome = mkdtempSync(join(tmpdir(), "wrap-session-test-"));
  process.env.WRAP_HOME = tmpHome;
  stdoutLines = [];
  originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    stdoutLines.push(args.map((a) => String(a)).join(" "));
  };
  resetDialogHostCache();
});

afterEach(() => {
  stderr.restore();
  console.log = originalConsoleLog;
  delete process.env.WRAP_HOME;
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

describe("runSession — initial low-risk command", () => {
  test("low-risk command runs without dialog and exits 0", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "echo hello", risk_level: "low" } as CommandResponse,
    ]);
    const exit = await runSession("say hi", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
  });
});

describe("runSession — initial answer", () => {
  test("answer is printed to stdout and exits 0", async () => {
    const { provider } = makeProvider([
      { type: "reply", content: "the answer", risk_level: "low" } as CommandResponse,
    ]);
    const exit = await runSession("question?", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stdoutLines.join("")).toContain("the answer");
  });
});

describe("runSession — exhausted", () => {
  test("loop exhaustion exits 1 with chrome notice", async () => {
    const step: CommandResponse = {
      type: "command",
      final: false,
      content: "true",
      risk_level: "low",
    };
    const { provider } = makeProvider([step, step, step]);
    const exit = await runSession("hmm", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
      maxRounds: 2,
    });
    expect(exit).toBe(1);
    expect(stderr.text).toContain("Could not resolve");
  });
});

describe("runSession — error path", () => {
  test("LLM throw bubbles into outcome and runs the log finally", async () => {
    const provider: Provider = {
      runPrompt: async () => {
        throw new Error("network down");
      },
    };
    let thrown: Error | undefined;
    try {
      await runSession("test", provider, {
        cwd: "/tmp",
        resolvedProvider: TEST_RESOLVED_PROVIDER,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain("network down");
  });
});

describe("runSession — no TTY for medium command", () => {
  test("medium-risk command without TTY → blocked, exit 1", async () => {
    // Force isTTY false via the existing mockStderr.
    stderr.restore();
    stderr = mockStderr({ isTTY: false });
    const { provider } = makeProvider([
      { type: "command", content: "rm a", risk_level: "medium" } as CommandResponse,
    ]);
    const exit = await runSession("delete it", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(1);
    expect(stderr.text).toContain("requires confirmation");
  });
});

describe("runSession — multi-round step → reply", () => {
  test("step followed by reply logs both rounds and exits 0", async () => {
    const { provider } = makeProvider([
      { type: "command", final: false, content: "echo hi", risk_level: "low" },
      { type: "reply", final: true, content: "the answer", risk_level: "low" },
    ]);
    const exit = await runSession("test", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stdoutLines.join("")).toContain("the answer");
    // Verify the log entry has BOTH rounds (the step and the reply)
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(tmpHome, "logs/wrap.jsonl"), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop() ?? "{}");
    expect(entry.rounds).toHaveLength(2);
    expect(entry.rounds[0].parsed.type).toBe("command");
    expect(entry.rounds[0].parsed.final).toBe(false);
    expect(entry.rounds[1].parsed.type).toBe("reply");
  });

  test("captured step output never lands on stderr (only the chrome explanation does)", async () => {
    // Regression test: the runner yields a `step-output` event that the
    // session forwards to the notification bus. `writeNotificationToStderr`
    // MUST drop step-output (it's dialog-only), otherwise during `thinking`
    // the user would see raw grep results streamed to their terminal.
    const SECRET = "OUTPUT_THAT_MUST_NOT_LEAK_TO_STDERR";
    const { provider } = makeProvider([
      {
        type: "command",
        final: false,
        content: `echo ${SECRET}`,
        risk_level: "low",
        explanation: "Find the secret",
      },
      { type: "reply", final: true, content: "done", risk_level: "low" },
    ]);
    const exit = await runSession("test", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    // The probe explanation IS chrome and SHOULD appear on stderr.
    expect(stderr.text).toContain("Find the secret");
    // The captured probe output MUST NOT appear on stderr.
    expect(stderr.text).not.toContain(SECRET);
  });
});
