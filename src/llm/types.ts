import type { ZodType } from "zod";

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

export type PromptInput = {
  system: string;
  messages: ConversationMessage[];
};

export type Provider = {
  runPrompt(input: PromptInput, schema?: ZodType): Promise<unknown>;
};

/** Final state used by `initProvider` after override resolution. */
export type ResolvedProvider = {
  name: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
};

/** Display label for a resolved provider — used in verbose log lines and UI. */
export function formatProvider(resolved: ResolvedProvider): string {
  return `${resolved.name} / ${resolved.model}`;
}
