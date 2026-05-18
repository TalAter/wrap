import type { ConversationMessage } from "./types.ts";

export type PromptConfig = {
  instruction: string;
  schemaInstruction: string;
  schemaText: string;
  memoryRecencyInstruction: string;
  toolsScopeInstruction: string;
  voiceInstructions: string;
  tempDirPrinciple: string;
  finalFlagInstruction: string;
  attachedInputInstruction?: string;
  fewShotExamples: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  fewShotSeparator: string;
  sectionUserRequest: string;
};

/**
 * The static, per-session pieces of the prompt: system text, few-shot
 * example messages (as a flat conversation prefix), and the formatted
 * `contextString` (memory, tools, cwd, attached input). The session passes
 * `contextString` + `sectionUserRequest` to `buildPromptInput` as a
 * `requestFraming` directive so the first user turn is wrapped at
 * projection time — storage is bare, framing is per-invocation.
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
   * The formatted context block (memory/tools/cwd/attached input). Wrapped
   * around the first user turn at projection time via `requestFraming`. May
   * be empty.
   */
  contextString: string;
  /** Pinned section header — paired with `contextString` in `requestFraming`. */
  sectionUserRequest: string;
};

/** Assemble the per-session prompt scaffold. Pure function. */
export function buildPromptScaffold(config: PromptConfig, contextString: string): PromptScaffold {
  const systemParts: string[] = [
    config.instruction,
    config.memoryRecencyInstruction,
    config.toolsScopeInstruction,
    config.voiceInstructions,
    config.tempDirPrinciple,
    config.finalFlagInstruction,
  ];
  if (config.attachedInputInstruction) {
    systemParts.push(config.attachedInputInstruction);
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

  return {
    system: systemParts.join("\n\n"),
    prefixMessages,
    contextString,
    sectionUserRequest: config.sectionUserRequest,
  };
}
