import type { ToolProbeResult } from "../discovery/init-probes.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import promptOptimized from "../prompt.optimized.json";
import { buildPrompt } from "./build-prompt.ts";
import { formatContext } from "./format-context.ts";
import type { PromptInput } from "./types.ts";

export type QueryContext = {
  prompt: string;
  cwd: string;
  memory: Memory;
  pipedInput?: string;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  piped?: boolean;
};

/** Assemble a PromptInput for a command prompt call. */
export function assembleCommandPrompt(ctx: QueryContext, maxPipedInputChars?: number): PromptInput {
  const contextString = formatContext({
    memory: ctx.memory,
    tools: ctx.tools,
    cwdFiles: ctx.cwdFiles,
    cwd: ctx.cwd,
    piped: ctx.piped,
    pipedInput: ctx.pipedInput,
    maxPipedInputChars,
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
