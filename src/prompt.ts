import { FEW_SHOT_DEMOS, SCHEMA_TEXT, SYSTEM_PROMPT } from "./prompt.optimized.ts";

export type PromptParts = {
  system: string;
  schema?: string;
  fewShotDemos?: { input: string; output: string }[];
};

export function assemblePromptParts(): PromptParts {
  return {
    system: SYSTEM_PROMPT,
    schema: SCHEMA_TEXT || undefined,
    fewShotDemos: FEW_SHOT_DEMOS.length > 0 ? [...FEW_SHOT_DEMOS] : undefined,
  };
}
