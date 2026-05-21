/**
 * Coordinator integration tests using the test provider stub.
 *
 * These exercise `runSession` with mocked stdin/stdout/stderr where needed.
 * The dialog itself is unit-tested in `dialog.test.tsx`; here we go end-to-end
 * — but we drive interactions by injecting key events into the Ink stdin
 * stream and observing the resulting outcome.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandResponse } from "../src/command-response.schema.ts";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import type { Provider } from "../src/llm/types.ts";
import { resetDialogHostCache } from "../src/session/dialog-host.ts";
import { runSession } from "../src/session/session.ts";
import type { Skill } from "../src/skills/index.ts";
import { seedTestConfig } from "./helpers.ts";
import { capturedStderr as stderr, capturedStdout as stdout } from "./preload.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

beforeEach(() => {
  seedTestConfig();
  rmSync(join(TEST_HOME, "logs"), { recursive: true, force: true });
  resetDialogHostCache();
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
    expect(stdout.text).toContain("the answer");
  });

  test("yolo + answer: stdout output, exit 0 (yolo has no effect on replies)", async () => {
    seedTestConfig({ yolo: true });
    const { provider } = makeProvider([
      { type: "reply", content: "the answer", risk_level: "low" } as CommandResponse,
    ]);
    const exit = await runSession("question?", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stdout.text).toContain("the answer");
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
    seedTestConfig({ maxRounds: 2 });
    const exit = await runSession("hmm", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
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
  // Global `stderr` already captures writes; just toggle isTTY for these.
  const origIsTTY = process.stderr.isTTY;
  beforeEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
  });

  test("medium-risk command without TTY → blocked, exit 1", async () => {
    const { provider } = makeProvider([
      { type: "command", content: "echo rm-a-fake", risk_level: "medium" } as CommandResponse,
    ]);
    const exit = await runSession("delete it", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(1);
    expect(stderr.text).toContain("requires confirmation");
  });

  test("yolo + medium command without TTY → not blocked, runs and exits 0", async () => {
    seedTestConfig({ yolo: true });
    const { provider } = makeProvider([
      { type: "command", content: "echo ok", risk_level: "medium" } as CommandResponse,
    ]);
    const exit = await runSession("do it", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stderr.text).not.toContain("requires confirmation");
  });
});

describe("runSession — multi-round step → reply", () => {
  test("step followed by reply logs both assistant turns and exits 0", async () => {
    const { provider } = makeProvider([
      { type: "command", final: false, content: "echo hi", risk_level: "low" },
      { type: "reply", final: true, content: "the answer", risk_level: "low" },
    ]);
    const exit = await runSession("test", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stdout.text).toContain("the answer");
    // Verify the log entry has both assistant turns (step response + reply)
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(TEST_HOME, "logs/wrap.jsonl"), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop() ?? "{}");
    const assistants = entry.turns.filter((t: { kind: string }) => t.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].response.type).toBe("command");
    expect(assistants[0].response.final).toBe(false);
    expect(assistants[1].response.type).toBe("reply");
  });

  test("skills passed to runSession emit turns before the user prompt (argv path)", async () => {
    // runSession owns skill execution. main.ts passes a `skills` array, and
    // runSession splices the resulting turn pairs in BEFORE the user turn so
    // the user's natural-language request stays the freshest message.
    const sentinel: Skill = {
      name: "sentinel",
      trigger: { kind: "always" },
      tasks: () => [
        { command: "echo sentinel", run: async () => ({ output: "SENTINEL_OUT", exitCode: 0 }) },
      ],
    };
    const { provider } = makeProvider([
      { type: "reply", content: "ok", risk_level: "low" } as CommandResponse,
    ]);
    const exit = await runSession("hello", provider, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
      skills: [sentinel],
    });
    expect(exit).toBe(0);
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(TEST_HOME, "logs/wrap.jsonl"), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop() ?? "{}");
    const userIdx = entry.turns.findIndex((t: { kind: string }) => t.kind === "user");
    expect(userIdx).toBeGreaterThan(0);
    const skillStep = entry.turns
      .slice(0, userIdx)
      .find(
        (t: { kind: string; command?: string; source?: unknown }) =>
          t.kind === "step" && t.command === "echo sentinel",
      );
    expect(skillStep).toBeDefined();
    expect(skillStep.output).toBe("SENTINEL_OUT");
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
