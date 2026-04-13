import type { CommandResponse } from "../../src/command-response.schema.ts";
import type { LoopOptions } from "../../src/core/runner.ts";
import { TEST_RESOLVED_PROVIDER } from "../../src/llm/providers/test.ts";
import { formatProvider, type Provider } from "../../src/llm/types.ts";
import { createLogEntry, type LogEntry } from "../../src/logging/entry.ts";

/**
 * Test fixtures shared by tests that exercise `runLoop` or `runSession`
 * directly. Kept here so the test files don't drift on the basics
 * (provider stub, log-entry shape, default options).
 */

export function makeProvider(responses: CommandResponse[]): {
  provider: Provider;
  readonly calls: number;
} {
  let calls = 0;
  const provider: Provider = {
    runPrompt: async () => {
      const r = responses[calls];
      calls += 1;
      if (!r) throw new Error(`unexpected call ${calls}`);
      return r;
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}

export function makeEntry(): LogEntry {
  return createLogEntry({
    prompt: "test",
    cwd: "/tmp",
    provider: TEST_RESOLVED_PROVIDER,
    promptHash: "h",
  });
}

export function makeOptions(overrides: Partial<LoopOptions> = {}): LoopOptions {
  return {
    cwd: "/tmp",
    wrapHome: "/tmp",
    model: formatProvider(TEST_RESOLVED_PROVIDER),
    pipedInput: undefined,
    showSpinner: false,
    ...overrides,
  };
}
