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

export type TestProviderConfig = { type: "test" };

export type ClaudeCodeProviderConfig = { type: "claude-code"; model?: string };

export type AISDKProviderConfig = {
  type: "anthropic" | "openai";
  model?: string;
  apiKey?: string;
  baseURL?: string;
};

export type ProviderConfig = TestProviderConfig | ClaudeCodeProviderConfig | AISDKProviderConfig;

/** Human-readable label for a provider config (model name or provider type). */
export function providerLabel(config: ProviderConfig): string {
  if ("model" in config && config.model) return config.model;
  return config.type;
}
