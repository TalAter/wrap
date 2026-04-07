import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LanguageModelUsage, NoObjectGeneratedError } from "ai";
import { extractFailedText, fetchesUrl, isStructuredOutputError } from "../src/core/query.ts";
import { SPINNER_TEXT } from "../src/core/spinner.ts";
import { type MockStderr, mockStderr } from "./helpers/mock-stderr.ts";

const STUB_USAGE: LanguageModelUsage = {
  inputTokens: undefined,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: undefined,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: undefined,
};

function mockNoObjectError(opts: { text?: string } = {}) {
  return new NoObjectGeneratedError({
    ...opts,
    response: { id: "", timestamp: new Date(), modelId: "" },
    usage: STUB_USAGE,
    finishReason: "stop",
  });
}

describe("isStructuredOutputError", () => {
  test("detects NoObjectGeneratedError", () => {
    expect(isStructuredOutputError(mockNoObjectError({ text: "bad" }))).toBe(true);
  });

  test("detects error with 'invalid JSON' message", () => {
    expect(isStructuredOutputError(new Error("LLM returned invalid JSON."))).toBe(true);
  });

  test("detects error with 'invalid response' message", () => {
    expect(isStructuredOutputError(new Error("LLM returned an invalid response."))).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isStructuredOutputError(new Error("network timeout"))).toBe(false);
  });

  test("rejects non-errors", () => {
    expect(isStructuredOutputError("string")).toBe(false);
    expect(isStructuredOutputError(null)).toBe(false);
  });
});

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

describe("extractFailedText", () => {
  test("extracts text from NoObjectGeneratedError", () => {
    expect(extractFailedText(mockNoObjectError({ text: "bad output here" }))).toBe(
      "bad output here",
    );
  });

  test("returns empty string for NoObjectGeneratedError without text", () => {
    expect(extractFailedText(mockNoObjectError())).toBe("");
  });

  test("returns empty string for other errors", () => {
    expect(extractFailedText(new Error("something"))).toBe("");
  });
});

describe("round retry in runQuery", () => {
  const originalConsoleLog = console.log;
  let stdoutOutput: string[];
  let stderr: MockStderr;

  beforeEach(() => {
    stdoutOutput = [];
    console.log = (...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    };
    stderr = mockStderr();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    stderr.restore();
  });

  test("retries on structured output error and succeeds", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runQuery } = await import("../src/core/query.ts");

    const wrapHome = mkdtempSync(join(tmpdir(), "wrap-retry-test-"));
    writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');

    let callCount = 0;
    const provider = {
      runPrompt: async (_input: unknown, _schema: unknown) => {
        callCount++;
        if (callCount === 1) {
          throw mockNoObjectError({ text: "not valid json" });
        }
        // Second call succeeds
        return { type: "answer", content: "retried ok", risk_level: "low" };
      },
    };

    const exitCode = await runQuery("test", provider, {
      cwd: "/tmp",
      providerConfig: { type: "test" },
    });
    expect(callCount).toBe(2);
    expect(exitCode).toBe(0);
    expect(stdoutOutput.join("")).toContain("retried ok");
  });

  test("does not retry on non-structured-output errors", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runQuery } = await import("../src/core/query.ts");

    const wrapHome = mkdtempSync(join(tmpdir(), "wrap-retry-test-"));
    writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');

    let callCount = 0;
    const provider = {
      runPrompt: async () => {
        callCount++;
        throw new Error("network failure");
      },
    };

    try {
      await runQuery("test", provider, {
        cwd: "/tmp",
        providerConfig: { type: "test" },
      });
    } catch {
      // expected
    }
    expect(callCount).toBe(1);
  });
});

describe("chrome spinner around LLM call", () => {
  const originalConsoleLog = console.log;
  let stderr: MockStderr | null = null;

  beforeEach(() => {
    console.log = () => {};
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    stderr?.restore();
    stderr = null;
  });

  test("renders 'thinking...' spinner when stderr is a TTY", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runQuery } = await import("../src/core/query.ts");
    const { resetVerbose } = await import("../src/core/verbose.ts");

    resetVerbose();
    stderr = mockStderr({ isTTY: true });

    const wrapHome = mkdtempSync(join(tmpdir(), "wrap-spinner-test-"));
    writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');

    const provider = {
      runPrompt: async () => ({ type: "answer", content: "ok", risk_level: "low" }),
    };

    await runQuery("test", provider, {
      cwd: "/tmp",
      providerConfig: { type: "test" },
    });

    expect(stderr.text).toContain(SPINNER_TEXT);
    // The cursor is hidden during the spinner and restored after.
    expect(stderr.text).toContain("\x1b[?25l"); // HIDE_CURSOR
    expect(stderr.text).toContain("\x1b[?25h"); // SHOW_CURSOR
  });

  test("does not render the spinner when stderr is not a TTY", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runQuery } = await import("../src/core/query.ts");
    const { resetVerbose } = await import("../src/core/verbose.ts");

    resetVerbose();
    stderr = mockStderr({ isTTY: false });

    const wrapHome = mkdtempSync(join(tmpdir(), "wrap-spinner-test-"));
    writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');

    const provider = {
      runPrompt: async () => ({ type: "answer", content: "ok", risk_level: "low" }),
    };

    await runQuery("test", provider, {
      cwd: "/tmp",
      providerConfig: { type: "test" },
    });

    expect(stderr.text).not.toContain(SPINNER_TEXT);
  });
});
