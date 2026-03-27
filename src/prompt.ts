import { FEW_SHOT_EXAMPLES, SCHEMA_TEXT, SYSTEM_PROMPT } from "./prompt.optimized.ts";

export type PromptParts = {
  system: string;
  schema?: string;
  fewShotExamples?: { input: string; output: string }[];
};

export function assemblePromptParts(): PromptParts {
  return {
    system: SYSTEM_PROMPT,
    schema: SCHEMA_TEXT || undefined,
    fewShotExamples: FEW_SHOT_EXAMPLES.length > 0 ? [...FEW_SHOT_EXAMPLES] : undefined,
  };
}
