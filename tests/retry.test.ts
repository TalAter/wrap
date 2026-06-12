import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchesUrl } from "../src/core/runner.ts";
import { SPINNER_TEXT } from "../src/core/spinner.ts";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";
import { runSession } from "../src/session/session.ts";
import { makeLlm } from "./helpers/llm-fixtures.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";
import { seedTestConfig } from "./helpers.ts";
import { capturedStdout as stdout } from "./preload.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

function lastLogEntry() {
  const log = readFileSync(join(TEST_HOME, "logs/wrap.jsonl"), "utf-8");
  return JSON.parse(log.trim().split("\n").pop() ?? "{}");
}

describe("fetchesUrl", () => {
  test("detects bare curl with https URL", () => {
    expect(fetchesUrl("curl -sL https://example.com")).toBe(true);
  });

  test("detects curl with http URL", () => {
    expect(fetchesUrl("curl http://example.com")).toBe(true);
  });

  test("detects wget with URL", () => {
    expect(fetchesUrl("wget -qO- https://example.com")).toBe(true);
  });

  test("detects curl piped through textutil", () => {
    expect(
      fetchesUrl(
        "curl -sL --max-time 10 https://ollama.com/ | textutil -stdin -format html -convert txt -stdout",
      ),
    ).toBe(true);
  });

  test("does not flag which probes", () => {
    expect(fetchesUrl("which sips convert magick")).toBe(false);
  });

  test("does not flag cat probes", () => {
    expect(fetchesUrl("cat package.json")).toBe(false);
  });

  test("does not flag curl without a URL (e.g. --version)", () => {
    expect(fetchesUrl("curl --version")).toBe(false);
  });

  test("does not flag commands that merely mention a URL", () => {
    expect(fetchesUrl("echo https://example.com")).toBe(false);
  });

  test("ignores leading whitespace", () => {
    expect(fetchesUrl("  curl -sL https://example.com")).toBe(true);
  });
});

describe("parse retry in runSession", () => {
  beforeEach(() => {
    seedTestConfig();
  });

  test("recovers from a parse failure via the send's one retry", async () => {
    const llm = makeLlm([
      "not valid json",
      { type: "reply", content: "retried ok", risk_level: "low" },
    ]);
    const exitCode = await runSession("test", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });
    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("retried ok");
    // Both physical attempts merge into the one assistant turn.
    const entry = lastLogEntry();
    const assistant = entry.turns.find((t: { kind: string }) => t.kind === "assistant");
    expect(assistant.attempts).toHaveLength(2);
    expect(assistant.attempts[0].error.kind).toBe("parse");
  });

  test("does not retry provider errors — a single attempt fails the round", async () => {
    const llm = makeLlm("ERROR:network failure");
    let thrown: Error | undefined;
    try {
      await runSession("test", llm, {
        cwd: "/tmp",
        resolvedProvider: TEST_RESOLVED_PROVIDER,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toContain("network failure");
    const entry = lastLogEntry();
    const assistant = entry.turns.find((t: { kind: string }) => t.kind === "assistant");
    expect(assistant.attempts).toHaveLength(1);
    expect(assistant.attempts[0].error.kind).toBe("provider");
  });

  test("wraps LLM errors with attempted provider/model label", async () => {
    // Anthropic's 404 body literally is `{"message":"model: gpt-4o-mini"}` —
    // the bare message gives no clue which provider rejected which model.
    // runSession must wrap thrown errors with the resolved provider label so
    // the user sees what was actually attempted.
    const llm = makeLlm("ERROR:model: gpt-4o-mini");
    let thrown: Error | undefined;
    try {
      await runSession("test", llm, {
        cwd: "/tmp",
        resolvedProvider: { name: "anthropic", model: "gpt-4o-mini" },
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    // Wrapping shows attempted provider/model so the user knows what was tried.
    expect(thrown?.message).toContain("anthropic / gpt-4o-mini");
    // Original provider message is preserved inside the wrapper.
    expect(thrown?.message).toContain("model: gpt-4o-mini");
  });
});

describe("chrome spinner around LLM call", () => {
  let stderr: MockStderr | null = null;

  afterEach(() => {
    stderr?.restore();
    stderr = null;
  });

  test("renders 'thinking...' spinner when stderr is a TTY", async () => {
    seedTestConfig();
    stderr = mockStderr({ isTTY: true });

    const llm = makeLlm([{ type: "reply", content: "ok", risk_level: "low" }]);
    await runSession("test", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });

    expect(stderr.text).toContain(SPINNER_TEXT);
    // The cursor is hidden during the spinner and restored after.
    expect(stderr.text).toContain("\x1b[?25l"); // HIDE_CURSOR
    expect(stderr.text).toContain("\x1b[?25h"); // SHOW_CURSOR
  });

  test("does not render the spinner when stderr is not a TTY", async () => {
    seedTestConfig();
    stderr = mockStderr({ isTTY: false });

    const llm = makeLlm([{ type: "reply", content: "ok", risk_level: "low" }]);
    await runSession("test", llm, {
      cwd: "/tmp",
      resolvedProvider: TEST_RESOLVED_PROVIDER,
    });

    expect(stderr.text).not.toContain(SPINNER_TEXT);
  });
});
