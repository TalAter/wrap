import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LanguageModelUsage, NoObjectGeneratedError } from "ai";
import { extractFailedText, fetchesUrl, isStructuredOutputError } from "../src/core/query.ts";
import { TEST_RESOLVED_PROVIDER } from "../src/llm/providers/test.ts";

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
  const originalStderrWrite = process.stderr.write;
  let stdoutOutput: string[];
  let stderrOutput: string[];

  beforeEach(() => {
    stdoutOutput = [];
    stderrOutput = [];
    console.log = (...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    };
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrOutput.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.stderr.write = originalStderrWrite;
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
      resolvedProvider: TEST_RESOLVED_PROVIDER,
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
        resolvedProvider: TEST_RESOLVED_PROVIDER,
      });
    } catch {
      // expected
    }
    expect(callCount).toBe(1);
  });

  test("wraps LLM errors with attempted provider/model label", async () => {
    // Anthropic's 404 body literally is `{"message":"model: gpt-4o-mini"}` —
    // the bare SDK message gives no clue which provider rejected which model.
    // runQuery must wrap thrown errors with the resolved provider label so the
    // user sees what was actually attempted.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runQuery } = await import("../src/core/query.ts");

    const wrapHome = mkdtempSync(join(tmpdir(), "wrap-retry-test-"));
    writeFileSync(join(wrapHome, "memory.json"), '{"/":[{"fact":"test"}]}');

    const provider = {
      runPrompt: async () => {
        throw new Error("model: gpt-4o-mini");
      },
    };

    let thrown: Error | undefined;
    try {
      await runQuery("test", provider, {
        cwd: "/tmp",
        resolvedProvider: { name: "anthropic", model: "gpt-4o-mini" },
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    // Wrapping shows attempted provider/model so the user knows what was tried.
    expect(thrown?.message).toContain("anthropic / gpt-4o-mini");
    // Original SDK message is preserved inside the wrapper.
    expect(thrown?.message).toContain("model: gpt-4o-mini");
  });
});
