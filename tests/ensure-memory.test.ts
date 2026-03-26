import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../src/llm/types.ts";
import { ensureMemory, parseInitResponse } from "../src/memory/memory.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wrap-ensure-memory-test-"));
}

function mockProvider(response: string): Provider {
  return {
    runPrompt: async () => response,
  };
}

describe("parseInitResponse", () => {
  test("splits lines into Fact objects", () => {
    const response = "Runs macOS on arm64\nDefault shell is zsh\nHas git installed";
    const entries = parseInitResponse(response);
    expect(entries).toEqual([
      { fact: "Runs macOS on arm64" },
      { fact: "Default shell is zsh" },
      { fact: "Has git installed" },
    ]);
  });

  test("trims whitespace and filters empty lines", () => {
    const response = "  fact one  \n\n  fact two  \n  \n";
    const entries = parseInitResponse(response);
    expect(entries).toEqual([{ fact: "fact one" }, { fact: "fact two" }]);
  });

  test("returns empty array for empty response", () => {
    expect(parseInitResponse("")).toEqual([]);
    expect(parseInitResponse("  \n  \n  ")).toEqual([]);
  });

  test("strips leading bullet markers", () => {
    const response = "- fact one\n- fact two\n• fact three";
    const entries = parseInitResponse(response);
    expect(entries).toEqual([{ fact: "fact one" }, { fact: "fact two" }, { fact: "fact three" }]);
  });
});

describe("ensureMemory", () => {
  const originalStderrWrite = process.stderr.write;
  let chromeOutput: string[];

  beforeEach(() => {
    chromeOutput = [];
    process.stderr.write = (chunk: string | Uint8Array) => {
      chromeOutput.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  test("loads existing memory without calling LLM", async () => {
    const dir = tempDir();
    const memory = { "/": [{ fact: "Runs macOS" }] };
    writeFileSync(join(dir, "memory.json"), JSON.stringify(memory));

    let llmCalled = false;
    const provider: Provider = {
      runPrompt: async () => {
        llmCalled = true;
        return "";
      },
    };

    const result = await ensureMemory(provider, dir);
    expect(result).toEqual(memory);
    expect(llmCalled).toBe(false);
    expect(chromeOutput).toEqual([]);
  });

  test("runs init when no memory exists", async () => {
    const dir = tempDir();
    const provider = mockProvider("Runs macOS on arm64\nDefault shell is zsh");

    const result = await ensureMemory(provider, dir);
    expect(result).toEqual({
      "/": [{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }],
    });
    const output = chromeOutput.join("");
    expect(output).toContain("Learning about your system");
    expect(output).toContain("Detected");
  });

  test("persists memory after init", async () => {
    const dir = tempDir();
    const provider = mockProvider("Runs macOS on arm64");

    await ensureMemory(provider, dir);

    // Second call should load from disk, not call LLM
    let llmCalled = false;
    const provider2: Provider = {
      runPrompt: async () => {
        llmCalled = true;
        return "";
      },
    };
    const result = await ensureMemory(provider2, dir);
    expect(result).toEqual({ "/": [{ fact: "Runs macOS on arm64" }] });
    expect(llmCalled).toBe(false);
  });

  test("throws when LLM fails", async () => {
    const dir = tempDir();
    const provider: Provider = {
      runPrompt: async () => {
        throw new Error("network error");
      },
    };

    expect(ensureMemory(provider, dir)).rejects.toThrow("network error");
    expect(chromeOutput.join("")).toContain("Learning about your system");
    expect(chromeOutput.join("")).not.toContain("Detected");
  });

  test("passes probe output as user message to LLM", async () => {
    const dir = tempDir();
    let capturedInput: unknown;
    const provider: Provider = {
      runPrompt: async (input) => {
        capturedInput = input;
        return "some fact";
      },
    };

    await ensureMemory(provider, dir);
    const { messages } = capturedInput as { messages: { content: string }[] };
    expect(messages[0].content).toContain("## OS");
    expect(messages[0].content).toContain("## Shell");
  });

  test("facts saved under / scope in new map format", async () => {
    const dir = tempDir();
    const provider = mockProvider("fact one\nfact two");

    const result = await ensureMemory(provider, dir);
    expect(result).toEqual({ "/": [{ fact: "fact one" }, { fact: "fact two" }] });
    expect(result["/"]).toHaveLength(2);
  });
});
