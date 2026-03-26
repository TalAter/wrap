import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoObjectGeneratedError } from "ai";
import { extractFailedText, isStructuredOutputError } from "../src/core/query.ts";

describe("isStructuredOutputError", () => {
  test("detects NoObjectGeneratedError", () => {
    const e = new NoObjectGeneratedError({ text: "bad" });
    expect(isStructuredOutputError(e)).toBe(true);
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

describe("extractFailedText", () => {
  test("extracts text from NoObjectGeneratedError", () => {
    const e = new NoObjectGeneratedError({ text: "bad output here" });
    expect(extractFailedText(e)).toBe("bad output here");
  });

  test("returns empty string for NoObjectGeneratedError without text", () => {
    const e = new NoObjectGeneratedError({});
    expect(extractFailedText(e)).toBe("");
  });

  test("returns empty string for other errors", () => {
    expect(extractFailedText(new Error("something"))).toBe("");
  });
});

describe("structured output retry in runQuery", () => {
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
    writeFileSync(join(wrapHome, "memory.json"), '[{"fact":"test"}]');

    let callCount = 0;
    const provider = {
      runPrompt: async (_input: unknown, _schema: unknown) => {
        callCount++;
        if (callCount === 1) {
          throw new NoObjectGeneratedError({ text: "not valid json" });
        }
        // Second call succeeds
        return { type: "answer", content: "retried ok", risk_level: "low" };
      },
    };

    const exitCode = await runQuery("test", provider, {
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
    writeFileSync(join(wrapHome, "memory.json"), '[{"fact":"test"}]');

    let callCount = 0;
    const provider = {
      runPrompt: async () => {
        callCount++;
        throw new Error("network failure");
      },
    };

    try {
      await runQuery("test", provider, {
        providerConfig: { type: "test" },
      });
    } catch {
      // expected
    }
    expect(callCount).toBe(1);
  });
});
