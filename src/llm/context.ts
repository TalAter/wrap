import type { ToolProbeResult } from "../discovery/init-probes.ts";
import type { Memory } from "../memory/types.ts";
import promptConstants from "../prompt.constants.json";
import promptOptimized from "../prompt.optimized.json";
import { buildPromptScaffold, type PromptScaffold } from "./build-prompt.ts";
import { formatContext } from "./format-context.ts";

export type QueryContext = {
  cwd: string;
  memory: Memory;
  tools?: ToolProbeResult | null;
  cwdFiles?: string;
  piped?: boolean;
  attachedInputPath?: string;
  attachedInputSize?: number;
  attachedInputPreview?: string;
  attachedInputTruncated?: boolean;
};

/**
 * Assemble the per-session prompt scaffold (system text, static prefix
 * messages, formatted context block). The session calls this once at
 * startup; the runner re-uses everything on every `runRound` call via
 * `buildPromptInput`. The user's bare prompt is NOT part of the scaffold —
 * it's stored as a `user` Turn and framed at projection time.
 */
export function assemblePromptScaffold(ctx: QueryContext): PromptScaffold {
  const contextString = formatContext({
    memory: ctx.memory,
    tools: ctx.tools,
    cwdFiles: ctx.cwdFiles,
    cwd: ctx.cwd,
    piped: ctx.piped,
    attachedInputPath: ctx.attachedInputPath,
    attachedInputSize: ctx.attachedInputSize,
    attachedInputPreview: ctx.attachedInputPreview,
    attachedInputTruncated: ctx.attachedInputTruncated,
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
      tempDirPrinciple: promptConstants.tempDirPrinciple,
      finalFlagInstruction: promptConstants.finalFlagInstruction,
      attachedInputInstruction:
        ctx.attachedInputPreview !== undefined
          ? promptConstants.attachedInputInstruction
          : undefined,
      fewShotExamples: promptOptimized.fewShotExamples,
      fewShotSeparator: promptConstants.fewShotSeparator,
      sectionUserRequest: promptConstants.sectionUserRequest,
    },
    contextString,
  );
}
