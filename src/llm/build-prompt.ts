import type { ConversationMessage, PromptInput } from "./types.ts";

export type PromptConfig = {
  instruction: string;
  schemaInstruction: string;
  schemaText: string;
  memoryRecencyInstruction: string;
  toolsScopeInstruction: string;
  voiceInstructions: string;
  fewShotExamples: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  fewShotSeparator: string;
  sectionUserRequest: string;
};

/** Assemble system message + messages array from config, context string, and query. Pure function. */
export function buildPrompt(
  config: PromptConfig,
  contextString: string,
  query: string,
): PromptInput {
  const systemParts: string[] = [
    config.instruction,
    config.memoryRecencyInstruction,
    config.toolsScopeInstruction,
    config.voiceInstructions,
  ];
  if (config.schemaText) {
    systemParts.push(`${config.schemaInstruction}\n${config.schemaText}`);
  }

  const messages: ConversationMessage[] = [];

  if (config.fewShotExamples.length > 0) {
    for (const example of config.fewShotExamples) {
      messages.push({ role: "user", content: example.input });
      messages.push({ role: "assistant", content: example.output });
    }
    messages.push({ role: "user", content: config.fewShotSeparator });
  }

  const userParts: string[] = [];
  if (contextString) {
    userParts.push(contextString);
  }
  if (query) {
    userParts.push(`${config.sectionUserRequest}\n${query}`);
  }

  messages.push({ role: "user", content: userParts.join("\n\n") });

  return { system: systemParts.join("\n\n"), messages };
}
