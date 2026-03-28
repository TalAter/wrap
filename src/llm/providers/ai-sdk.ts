import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { type ZodType, z } from "zod";
import type { AISDKProviderConfig, Provider } from "../types.ts";

const DEFAULT_MODELS = {
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

/**
 * OpenAI strict mode requires every property in `required`.
 * Our Zod schema uses .nullable().optional() so the JSON schema already has
 * anyOf: [type, null] for optional fields — we just need to add them to `required`.
 */
function toOpenAIStrictSchema(zodSchema: ZodType) {
  const raw = structuredClone(z.toJSONSchema(zodSchema)) as Record<string, unknown>;
  addAllToRequired(raw);
  return jsonSchema(raw, {
    validate: (value) => {
      const result = zodSchema.safeParse(value);
      if (result.success) return { success: true as const, value: result.data };
      return { success: false as const, error: result.error as Error };
    },
  });
}

function addAllToRequired(node: Record<string, unknown>): void {
  if (node.type === "object" && node.properties) {
    const props = node.properties as Record<string, Record<string, unknown>>;
    node.required = Object.keys(props);
    for (const child of Object.values(props)) addAllToRequired(child);
  }
  if (node.items) addAllToRequired(node.items as Record<string, unknown>);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[key])) {
      for (const child of node[key] as Record<string, unknown>[]) addAllToRequired(child);
    }
  }
}

export function aiSdkProvider(config: AISDKProviderConfig): Provider {
  const factory = MODEL_FACTORIES[config.type];
  if (!factory) throw new Error(`Config error: unsupported AI SDK provider "${config.type}".`);
  const model = factory(config);
  const useStrictSchema = config.type === "openai";

  return {
    runPrompt: async (input, schema?) => {
      if (schema) {
        const outputSchema = useStrictSchema ? toOpenAIStrictSchema(schema) : schema;
        const result = await generateText({
          model,
          system: input.system,
          messages: input.messages,
          output: Output.object({ schema: outputSchema }),
        });
        if (result.output === undefined) {
          throw new Error("LLM returned no structured output.");
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
