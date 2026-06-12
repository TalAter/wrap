/**
 * Coordinator integration tests using core's canned test provider.
 *
 * These exercise `runSession` with mocked stdin/stdout/stderr where needed.
 * The dialog itself is unit-tested in `dialog.test.tsx`; here we go end-to-end
 * — but we drive interactions by injecting key events into the Ink stdin
 * stream and observing the resulting outcome.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assemblePromptScaffold } from "../src/llm/context.ts";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import { resetDialogHostCache } from "../src/session/dialog-host.ts";
import { runSession } from "../src/session/session.ts";
import type { Skill } from "../src/skills/index.ts";
import { makeLlm } from "./helpers/llm-fixtures.ts";
import { seedTestConfig } from "./helpers.ts";
import { capturedStderr as stderr, capturedStdout as stdout } from "./preload.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

// --- few-shot prefix injection seam -----------------------------------------
// prompt.optimized.json currently ships zero few-shot examples, so the
// session's "feed scaffold.prefixMessages into the conversation" loop is
// invisible to every test that uses the real scaffold. This passthrough mock
// injects a prefix only while `injectedPrefix` is set; all other tests get
// the real scaffold untouched.
const realAssemble = assemblePromptScaffold;
let injectedPrefix: Array<{ role: "user" | "assistant"; content: string }> | null = null;
mock.module("../src/llm/context.ts", () => ({
  assemblePromptScaffold: (ctx: Parameters<typeof realAssemble>[0]) => {
    const scaffold = realAssemble(ctx);
    return injectedPrefix ? { ...scaffold, prefixMessages: injectedPrefix } : scaffold;
  },
}));

beforeEach(() => {
  seedTestConfig();
  rmSync(join(TEST_HOME, "logs"), { recursive: true, force: true });
  resetDialogHostCache();
  injectedPrefix = null;
});

describe("runSession — initial low-risk command", () => {
  test("low-risk command runs without dialog and exits 0", async () => {
    const llm = makeLlm([{ type: "command", content: "echo hello", risk_level: "low" }]);
    const exit = await runSession("say hi", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
  });
});

describe("runSession — initial answer", () => {
  test("answer is printed to stdout and exits 0", async () => {
    const llm = makeLlm([{ type: "reply", content: "the answer", risk_level: "low" }]);
    const exit = await runSession("question?", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stdout.text).toContain("the answer");
  });

  test("yolo + answer: stdout output, exit 0 (yolo has no effect on replies)", async () => {
    seedTestConfig({ yolo: true });
    const llm = makeLlm([{ type: "reply", content: "the answer", risk_level: "low" }]);
    const exit = await runSession("question?", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stdout.text).toContain("the answer");
  });
});

describe("runSession — exhausted", () => {
  test("loop exhaustion exits 1 with chrome notice", async () => {
    const step = { type: "command", final: false, content: "true", risk_level: "low" };
    const llm = makeLlm([step, step, step]);
    seedTestConfig({ maxRounds: 2 });
    const exit = await runSession("hmm", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(1);
    expect(stderr.text).toContain("Could not resolve");
  });
});

describe("runSession — error path", () => {
  test("LLM failure bubbles into outcome and runs the log finally", async () => {
    const llm = makeLlm("ERROR:network down");
    let thrown: Error | undefined;
    try {
      await runSession("test", llm, {
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
    const llm = makeLlm([{ type: "command", content: "echo rm-a-fake", risk_level: "medium" }]);
    const exit = await runSession("delete it", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(1);
    expect(stderr.text).toContain("requires confirmation");
  });

  test("yolo + medium command without TTY → not blocked, runs and exits 0", async () => {
    seedTestConfig({ yolo: true });
    const llm = makeLlm([{ type: "command", content: "echo ok", risk_level: "medium" }]);
    const exit = await runSession("do it", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);
    expect(stderr.text).not.toContain("requires confirmation");
  });
});

describe("runSession — multi-round step → reply", () => {
  test("step followed by reply logs both assistant turns and exits 0", async () => {
    const llm = makeLlm([
      { type: "command", final: false, content: "echo hi", risk_level: "low" },
      { type: "reply", final: true, content: "the answer", risk_level: "low" },
    ]);
    const exit = await runSession("test", llm, {
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
    const llm = makeLlm([{ type: "reply", content: "ok", risk_level: "low" }]);
    const exit = await runSession("hello", llm, {
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
    const probe = entry.turns
      .slice(0, userIdx)
      .find(
        (t: { kind: string; command?: string }) =>
          t.kind === "probe" && t.command === "echo sentinel",
      );
    expect(probe).toBeDefined();
    expect(probe.output).toBe("SENTINEL_OUT");
  });

  test("captured step output never lands on stderr (only the chrome explanation does)", async () => {
    // Regression test: the runner yields a `step-output` event that the
    // session forwards to the notification bus. `writeNotificationToStderr`
    // MUST drop step-output (it's dialog-only), otherwise during `thinking`
    // the user would see raw grep results streamed to their terminal.
    const SECRET = "OUTPUT_THAT_MUST_NOT_LEAK_TO_STDERR";
    const llm = makeLlm([
      {
        type: "command",
        final: false,
        content: `echo ${SECRET}`,
        risk_level: "low",
        explanation: "Find the secret",
      },
      { type: "reply", final: true, content: "done", risk_level: "low" },
    ]);
    const exit = await runSession("test", llm, {
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

describe("runSession — scaffold prefix messages", () => {
  test("the few-shot prefix leads the assembled request (logTraces)", async () => {
    seedTestConfig({ logTraces: true });
    injectedPrefix = [
      { role: "user", content: "FEW_SHOT_EXAMPLE_INPUT" },
      { role: "assistant", content: '{"type":"reply","final":true,"content":"FEW_SHOT_EXAMPLE"}' },
      { role: "user", content: "Now handle the following request." },
    ];
    const llm = makeLlm([{ type: "reply", content: "ok", risk_level: "low" }]);
    const exit = await runSession("hello there", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exit).toBe(0);

    const log = readFileSync(join(TEST_HOME, "logs/wrap.jsonl"), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop() ?? "{}") as { id: string };
    const trace = JSON.parse(
      readFileSync(join(TEST_HOME, "logs/traces", `${entry.id}.json`), "utf-8"),
    ) as {
      turn_attempts: Record<
        string,
        Array<{ request: { messages: Array<{ role: string; content: string }> } }>
      >;
    };
    const attempts = Object.values(trace.turn_attempts)[0];
    const messages = attempts?.[0]?.request.messages ?? [];
    // The session feeds scaffold.prefixMessages into the conversation as
    // real adds at startup: the assembled request opens with the few-shot
    // prefix pairs, verbatim and in order...
    expect(messages.slice(0, injectedPrefix.length)).toEqual(injectedPrefix);
    // ...and the (framed) user request follows the prefix.
    expect(messages[injectedPrefix.length]?.content).toContain("hello there");
  });
});
