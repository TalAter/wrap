import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { type ZodType, z } from "zod";
import type { Provider, ResolvedProvider } from "../types.ts";
import { getRegistration } from "./registry.ts";

/**
 * Build a `LanguageModel` for the given resolved provider. The dispatch on
 * `name` lives in `initProvider`; this file handles the SDK details for
 * anthropic / openai / openai-compat (ollama + unknown providers).
 */
function buildModel(resolved: ResolvedProvider, isOpenAICompat: boolean): LanguageModel {
  const { model } = resolved;
  // resolveProvider guarantees non-CLI providers have a model; assert loudly
  // rather than silently passing `undefined` to the SDK factory.
  if (!model) throw new Error(`LLM error: provider "${resolved.name}" has no model.`);
  if (isOpenAICompat) {
    // @ai-sdk/openai requires an API key even for local endpoints that don't need one.
    // When a custom baseURL is set and no key is provided, use a placeholder so local
    // models (Ollama, LM Studio, etc.) work without the user having to set a dummy key.
    return createOpenAI({
      apiKey: resolveApiKey(resolved.apiKey) ?? (resolved.baseURL ? "nokey" : undefined),
      baseURL: resolved.baseURL,
    })(model);
  }
  return createAnthropic({
    apiKey: resolveApiKey(resolved.apiKey),
    baseURL: resolved.baseURL,
  })(model);
}

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

export function aiSdkProvider(resolved: ResolvedProvider): Provider {
  // Anthropic uses its own SDK; everything else (openai, ollama, unknown
  // OpenAI-compat providers) flows through the OpenAI SDK factory and needs
  // strict-schema mode for structured output.
  const isOpenAICompat = getRegistration(resolved.name).kind === "openai-compat";
  const model = buildModel(resolved, isOpenAICompat);

  return {
    runPrompt: async (input, schema?) => {
      if (schema) {
        const outputSchema = isOpenAICompat ? toOpenAIStrictSchema(schema) : schema;
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
