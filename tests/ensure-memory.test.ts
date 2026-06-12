import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLlm, type Llm, type LlmMessage } from "wrap-core/llm";
import { ensureMemory } from "../src/memory/memory.ts";
import { seedTestConfig } from "./helpers.ts";
import { capturedStderr as stderr } from "./preload.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const MEMORY_PATH = join(TEST_HOME, "memory.json");

/** Core test-provider Llm whose init send returns the given facts. */
function factsLlm(facts: string[]): Llm {
  return createLlm({ name: "test", responses: [{ facts }] });
}

/** Llm that throws as a provider error if any send actually happens. */
function explodingLlm(message = "should not be called"): Llm {
  return createLlm({ name: "test", responses: `ERROR:${message}` });
}

/** Fake Llm capturing the conversation wiring; send returns `sendResult`. */
function captureLlm(sendResult: object): {
  llm: Llm;
  captured: { system: string | undefined; messages: LlmMessage[] };
} {
  const captured = { system: undefined as string | undefined, messages: [] as LlmMessage[] };
  const llm = {
    label: "test / capture",
    startConversation: (options: { system: string }) => {
      captured.system = options.system;
      return {
        add: (message: LlmMessage) => {
          captured.messages.push(message);
        },
        entries: [],
        send: async () => sendResult,
      };
    },
  } as unknown as Llm;
  return { llm, captured };
}

describe("ensureMemory", () => {
  beforeEach(() => {
    rmSync(MEMORY_PATH, { force: true });
    // verbose() reads the global config store; seed it so this file passes
    // standalone, not just after a suite-mate happens to call setConfig.
    seedTestConfig();
  });

  test("loads existing memory without calling the LLM", async () => {
    const memory = { "/": [{ fact: "Runs macOS" }] };
    writeFileSync(MEMORY_PATH, JSON.stringify(memory));

    // explodingLlm would reject the promise if a send happened.
    const result = await ensureMemory(explodingLlm());
    expect(result).toEqual(memory);
  });

  test("runs init when no memory exists", async () => {
    const result = await ensureMemory(factsLlm(["Runs macOS on arm64", "Default shell is zsh"]));
    expect(result).toEqual({
      "/": [{ fact: "Runs macOS on arm64" }, { fact: "Default shell is zsh" }],
    });
    const output = stderr.text;
    expect(output).toContain("Learning about your system");
    expect(output).toContain("Detected");
  });

  test("persists memory after init", async () => {
    await ensureMemory(factsLlm(["Runs macOS on arm64"]));

    // Second call should load from disk, not call the LLM.
    const result = await ensureMemory(explodingLlm());
    expect(result).toEqual({ "/": [{ fact: "Runs macOS on arm64" }] });
  });

  test("throws when the LLM fails, prefixed in wrap's voice", async () => {
    await expect(ensureMemory(explodingLlm("network error"))).rejects.toThrow(
      /^LLM error \(test \/ \(default\)\): network error$/,
    );
    expect(stderr.text).toContain("Learning about your system");
    expect(stderr.text).not.toContain("Detected");
    expect(existsSync(MEMORY_PATH)).toBe(false);
  });

  test("init send recovers via the spec-default parse retry", async () => {
    // The send retries a parse failure exactly once (core mechanics) — the
    // second canned entry satisfies the schema and init succeeds. The
    // legacy exactly-one-attempt pin died with the transitional
    // `{ retry: false }` opt-out at the main-loop flip.
    const llm = createLlm({ name: "test", responses: ["not json", { facts: ["x"] }] });
    const result = await ensureMemory(llm);
    expect(result).toEqual({ "/": [{ fact: "x" }] });
    expect(existsSync(MEMORY_PATH)).toBe(true);
  });

  test("init fails when both parse attempts come back malformed", async () => {
    const llm = createLlm({ name: "test", responses: ["not json", "still not json"] });
    await expect(ensureMemory(llm)).rejects.toThrow(/^LLM error \(test \/ \(default\)\): .*JSON/);
    expect(existsSync(MEMORY_PATH)).toBe(false);
  });

  test("schema-mismatch reply rejects instead of saving garbage", async () => {
    // Two entries: the parse retry consumes the second; both miss the schema.
    const llm = createLlm({ name: "test", responses: [{ wrong: "shape" }, { wrong: "shape" }] });
    await expect(ensureMemory(llm)).rejects.toThrow(/^LLM error \(test \/ \(default\)\): .*schema/);
    expect(existsSync(MEMORY_PATH)).toBe(false);
  });

  test("passes probe output as the single user message", async () => {
    const { llm, captured } = captureLlm({ facts: ["some fact"] });
    await ensureMemory(llm);
    expect(captured.system).toContain("system probe commands");
    expect(captured.messages).toHaveLength(1);
    const first = captured.messages[0];
    if (!first) throw new Error("expected a probe message");
    expect(first.role).toBe("user");
    expect(first.content).toContain("## OS");
    expect(first.content).toContain("## Shell");
  });

  test("facts saved under / scope in new map format", async () => {
    const result = await ensureMemory(factsLlm(["fact one", "fact two"]));
    expect(result).toEqual({ "/": [{ fact: "fact one" }, { fact: "fact two" }] });
    expect(result["/"]).toHaveLength(2);
  });

  test("trims facts and drops empty ones — sloppy output never persists", async () => {
    const result = await ensureMemory(factsLlm(["  Runs macOS  ", "", "   ", "Uses zsh"]));
    expect(result).toEqual({ "/": [{ fact: "Runs macOS" }, { fact: "Uses zsh" }] });
  });
});
