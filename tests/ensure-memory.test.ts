import { describe, expect, test } from "bun:test";
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
    runCommandPrompt: async () => response,
  };
}

describe("parseInitResponse", () => {
  test("splits lines into MemoryEntry facts", () => {
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
  test("loads existing memory without calling LLM", async () => {
    const dir = tempDir();
    const entries = [{ fact: "Runs macOS" }];
    writeFileSync(join(dir, "memory.json"), JSON.stringify(entries));

    let llmCalled = false;
    const provider = {
      runPrompt: async () => {
        llmCalled = true;
        return "";
      },
      runCommandPrompt: async () => "",
    };

    const result = await ensureMemory(provider, dir);
    expect(result).toEqual(entries);
    expect(llmCalled).toBe(false);
  });

  test("runs init when no memory exists", async () => {
    const dir = tempDir();
    const provider = mockProvider("Runs macOS on arm64\nDefault shell is zsh");

    const result = await ensureMemory(provider, dir);
    expect(result).toEqual([{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }]);
  });

  test("persists memory after init", async () => {
    const dir = tempDir();
    const provider = mockProvider("Runs macOS on arm64");

    await ensureMemory(provider, dir);

    // Second call should load from disk, not call LLM
    let llmCalled = false;
    const provider2 = {
      runPrompt: async () => {
        llmCalled = true;
        return "";
      },
      runCommandPrompt: async () => "",
    };
    const result = await ensureMemory(provider2, dir);
    expect(result).toEqual([{ fact: "Runs macOS on arm64" }]);
    expect(llmCalled).toBe(false);
  });

  test("throws when LLM fails", async () => {
    const dir = tempDir();
    const provider: Provider = {
      runPrompt: async () => {
        throw new Error("network error");
      },
      runCommandPrompt: async () => "",
    };

    expect(ensureMemory(provider, dir)).rejects.toThrow("network error");
  });

  test("passes probe output as user prompt to LLM", async () => {
    const dir = tempDir();
    let capturedUserPrompt = "";
    const provider: Provider = {
      runPrompt: async (_sys, user) => {
        capturedUserPrompt = user;
        return "some fact";
      },
      runCommandPrompt: async () => "",
    };

    await ensureMemory(provider, dir);
    // Should contain probe section headers
    expect(capturedUserPrompt).toContain("## OS");
    expect(capturedUserPrompt).toContain("## Shell");
  });
});
