import type { ToolProbeResult } from "../discovery/init-probes.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import promptOptimized from "../prompt.optimized.json";
import { buildPromptScaffold, type PromptScaffold } from "./build-prompt.ts";
import { formatContext } from "./format-context.ts";

export type QueryContext = {
  prompt: string;
  cwd: string;
  memory: Memory;
  pipedInput?: string;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  piped?: boolean;
};

/**
 * Assemble the per-session prompt scaffold (system text, static prefix
 * messages, and the initial user-turn text). The session calls this once
 * at startup; the runner re-uses `system` + `prefixMessages` on every
 * `runRound` call via `buildPromptInput`.
 */
export function assemblePromptScaffold(
  ctx: QueryContext,
  maxPipedInputChars?: number,
): PromptScaffold {
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

  return buildPromptScaffold(
    {
      instruction: promptOptimized.instruction,
      schemaInstruction: promptConstants.schemaInstruction,
      schemaText: promptOptimized.schemaText,
      memoryRecencyInstruction: promptConstants.memoryRecencyInstruction,
      toolsScopeInstruction: promptConstants.toolsScopeInstruction,
      voiceInstructions: promptConstants.voiceInstructions,
      pipedInputInstruction: ctx.pipedInput ? promptConstants.pipedInputInstruction : undefined,
      fewShotExamples: promptOptimized.fewShotExamples,
      fewShotSeparator: promptConstants.fewShotSeparator,
      sectionUserRequest: promptConstants.sectionUserRequest,
    },
    contextString,
    ctx.prompt,
  );
}
