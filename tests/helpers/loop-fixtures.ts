import type { CommandResponse } from "../../src/command-response.schema.ts";
import type { RoundsOptions } from "../../src/core/query.ts";
import { TEST_RESOLVED_PROVIDER } from "../../src/llm/providers/test.ts";
import {
  type ConversationMessage,
  formatProvider,
  type PromptInput,
  type Provider,
} from "../../src/llm/types.ts";
import { createLogEntry, type LogEntry } from "../../src/logging/entry.ts";

/**
 * Test fixtures shared by tests that exercise `runRoundsUntilFinal` or
 * `createFollowupHandler` directly. Kept here so the two test files don't
 * drift on the basics (provider stub, input shape, default options).
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

export function makeInput(extraMessages: ConversationMessage[] = []): PromptInput {
  return {
    system: "system",
    messages: [{ role: "user", content: "test" }, ...extraMessages],
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

export function makeOptions(overrides: Partial<RoundsOptions> = {}): RoundsOptions {
  return {
    cwd: "/tmp",
    wrapHome: "/tmp",
    model: formatProvider(TEST_RESOLVED_PROVIDER),
    maxRounds: 5,
    maxProbeOutput: 10000,
    pipedInput: undefined,
    ...overrides,
  };
}
