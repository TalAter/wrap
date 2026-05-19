import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../src/llm/types.ts";
import { ensureMemory, parseInitResponse } from "../src/memory/memory.ts";
import { capturedStderr as stderr } from "./preload.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const MEMORY_PATH = join(TEST_HOME, "memory.json");

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
  beforeEach(() => {
    rmSync(MEMORY_PATH, { force: true });
  });

  test("loads existing memory without calling LLM", async () => {
    const memory = { "/": [{ fact: "Runs macOS" }] };
    writeFileSync(MEMORY_PATH, JSON.stringify(memory));

    let llmCalled = false;
    const provider: Provider = {
      runPrompt: async () => {
        llmCalled = true;
        return "";
      },
    };

    const result = await ensureMemory(provider);
    expect(result).toEqual(memory);
    expect(llmCalled).toBe(false);
  });

  test("runs init when no memory exists", async () => {
    const provider = mockProvider("Runs macOS on arm64\nDefault shell is zsh");

    const result = await ensureMemory(provider);
    expect(result).toEqual({
      "/": [{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }],
    });
    const output = stderr.text;
    expect(output).toContain("Learning about your system");
    expect(output).toContain("Detected");
  });

  test("persists memory after init", async () => {
    const provider = mockProvider("Runs macOS on arm64");

    await ensureMemory(provider);

    // Second call should load from disk, not call LLM
    let llmCalled = false;
    const provider2: Provider = {
      runPrompt: async () => {
        llmCalled = true;
        return "";
      },
    };
    const result = await ensureMemory(provider2);
    expect(result).toEqual({ "/": [{ fact: "Runs macOS on arm64" }] });
    expect(llmCalled).toBe(false);
  });

  test("throws when LLM fails", async () => {
    const provider: Provider = {
      runPrompt: async () => {
        throw new Error("network error");
      },
    };

    expect(ensureMemory(provider)).rejects.toThrow("network error");
    expect(stderr.text).toContain("Learning about your system");
    expect(stderr.text).not.toContain("Detected");
  });

  test("passes probe output as user message to LLM", async () => {
    let capturedInput: unknown;
    const provider: Provider = {
      runPrompt: async (input) => {
        capturedInput = input;
        return "some fact";
      },
    };

    await ensureMemory(provider);
    const { messages } = capturedInput as { messages: { content: string }[] };
    const first = messages[0];
    if (!first) throw new Error("expected at least one message");
    expect(first.content).toContain("## OS");
    expect(first.content).toContain("## Shell");
  });

  test("facts saved under / scope in new map format", async () => {
    const provider = mockProvider("fact one\nfact two");

    const result = await ensureMemory(provider);
    expect(result).toEqual({ "/": [{ fact: "fact one" }, { fact: "fact two" }] });
    expect(result["/"]).toHaveLength(2);
  });
});
