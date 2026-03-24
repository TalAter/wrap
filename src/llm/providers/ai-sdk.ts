import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from "ai";
import type { AISDKProviderConfig, Provider } from "../types.ts";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-latest",
  openai: "gpt-4o-mini",
};

const MODEL_FACTORIES: Record<string, (config: AISDKProviderConfig) => LanguageModel> = {
  anthropic: (c) =>
    createAnthropic({ apiKey: resolveApiKey(c.apiKey), baseURL: c.baseURL })(
      c.model ?? DEFAULT_MODELS.anthropic,
    ),
  openai: (c) =>
    createOpenAI({ apiKey: resolveApiKey(c.apiKey), baseURL: c.baseURL })(
      c.model ?? DEFAULT_MODELS.openai,
    ),
};

export function aiSdkProvider(config: AISDKProviderConfig): Provider {
  const factory = MODEL_FACTORIES[config.type];
  if (!factory) throw new Error(`Config error: unsupported AI SDK provider "${config.type}".`);
  const model = factory(config);

  return {
    runPrompt: async (input, schema?) => {
      if (schema) {
        const result = await generateText({
          model,
          system: input.system,
          messages: input.messages,
          output: Output.object({ schema }),
        });
        if (result.output === undefined) {
          throw new NoObjectGeneratedError({ text: result.text, response: result.response });
        }
        return result.output;
      }
      const result = await generateText({
        model,
        system: input.system,
        messages: input.messages,
      });
      return result.text;
    },
  };
}

export function resolveApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("$")) {
    const envVar = value.slice(1);
    const resolved = process.env[envVar];
    if (!resolved) throw new Error(`Config error: environment variable ${envVar} is not set.`);
    return resolved;
  }
  return value;
}
