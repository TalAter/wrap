import { type Conversation, createLlm, type Llm, type TestResponses } from "wrap-core/llm";
import { formatCommandEcho } from "../../src/llm/framing.ts";

/**
 * LLM fixtures shared by tests that exercise `runRound`, `runLoop`, or
 * `runSession` over core's canned test provider. Kept here so the test
 * files don't drift on the basics.
 */

/** Core test LLM over canned responses — what `runSession` receives. */
export function makeLlm(responses: TestResponses): Llm {
  return createLlm({ name: "test", responses });
}

/** A conversation over the core test provider with wrap's echo predicate,
 *  pre-seeded with one user turn — the smallest round-able conversation
 *  (mirrors the session's seeding of the transcript's user turn). */
export function makeChat(responses: TestResponses): Conversation {
  const llm = makeLlm(responses);
  const chat = llm.startConversation({ system: "system", formatEcho: formatCommandEcho });
  chat.add({ role: "user", content: "hi" });
  return chat;
}

/** Total physical LLM calls recorded across the conversation's entries. */
export function physicalCalls(chat: Conversation): number {
  return chat.entries.flatMap((e) => e.attempts ?? []).length;
}
