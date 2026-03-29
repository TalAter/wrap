import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import promptOptimized from "../prompt.optimized.json";
import { buildPrompt } from "./build-prompt.ts";
import { formatContext } from "./format-context.ts";
import type { ConversationMessage, PromptInput } from "./types.ts";

export type QueryContext = {
  prompt: string;
  cwd: string;
  memory: Memory;
  threadHistory?: ConversationMessage[];
  pipedInput?: string;
  toolsOutput?: string;
  piped?: boolean;
};

/** Assemble a PromptInput for a command prompt call. */
export function assembleCommandPrompt(ctx: QueryContext): PromptInput {
  const contextString = formatContext({
    memory: ctx.memory,
    toolsOutput: ctx.toolsOutput,
    cwd: ctx.cwd,
    piped: ctx.piped,
    constants: promptConstants,
  });

  return buildPrompt(
    {
      instruction: promptOptimized.instruction,
      schemaInstruction: promptConstants.schemaInstruction,
      schemaText: promptOptimized.schemaText,
      memoryRecencyInstruction: promptConstants.memoryRecencyInstruction,
      toolsScopeInstruction: promptConstants.toolsScopeInstruction,
      voiceInstructions: promptConstants.voiceInstructions,
      fewShotExamples: promptOptimized.fewShotExamples,
      fewShotSeparator: promptConstants.fewShotSeparator,
      sectionUserRequest: promptConstants.sectionUserRequest,
    },
    contextString,
    ctx.prompt,
  );
}
