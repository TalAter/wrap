import type { ConversationMessage } from "./types.ts";

export type PromptConfig = {
  instruction: string;
  schemaInstruction: string;
  schemaText: string;
  memoryRecencyInstruction: string;
  toolsScopeInstruction: string;
  voiceInstructions: string;
  pipedInputInstruction?: string;
  fewShotExamples: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  fewShotSeparator: string;
  sectionUserRequest: string;
};

/**
 * The static, per-session pieces of the prompt: the system text, the few-shot
 * example messages (as a flat conversation prefix), and the formatted initial
 * user-request text. The session uses these to seed a `Transcript` and the
 * `LoopOptions`. Pure function — produced once at session start, not on
 * every round.
 */
export type PromptScaffold = {
  system: string;
  /**
   * Few-shot examples + separator, prepended verbatim to every round's
   * messages array by `buildPromptInput`. Empty if the prompt config has
   * no examples. Treated as immutable after assembly.
   */
  prefixMessages: ReadonlyArray<ConversationMessage>;
  /**
   * The text content of the initial user turn the session pushes to the
   * transcript: `${contextString}\n\n${sectionUserRequest}\n${query}` (or
   * whichever subset of those parts is non-empty).
   */
  initialUserText: string;
};

/** Assemble the per-session prompt scaffold. Pure function. */
export function buildPromptScaffold(
  config: PromptConfig,
  contextString: string,
  query: string,
): PromptScaffold {
  const systemParts: string[] = [
    config.instruction,
    config.memoryRecencyInstruction,
    config.toolsScopeInstruction,
    config.voiceInstructions,
  ];
  if (config.pipedInputInstruction) {
    systemParts.push(config.pipedInputInstruction);
  }
  if (config.schemaText) {
    systemParts.push(`${config.schemaInstruction}\n${config.schemaText}`);
  }

  const prefixMessages: ConversationMessage[] = [];
  if (config.fewShotExamples.length > 0) {
    for (const example of config.fewShotExamples) {
      prefixMessages.push({ role: "user", content: example.input });
      prefixMessages.push({ role: "assistant", content: example.output });
    }
    prefixMessages.push({ role: "user", content: config.fewShotSeparator });
  }

  const userParts: string[] = [];
  if (contextString) userParts.push(contextString);
  if (query) userParts.push(`${config.sectionUserRequest}\n${query}`);

  return {
    system: systemParts.join("\n\n"),
    prefixMessages,
    initialUserText: userParts.join("\n\n"),
  };
}
