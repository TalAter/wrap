import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { type ZodType, z } from "zod";
import { notifications } from "../../core/notify.ts";
import { scrubApiKey, type WireCapture, type WireRequest } from "../../logging/entry.ts";
import type { Provider, ResolvedProvider } from "../types.ts";
import { getRegistration } from "./registry.ts";

/**
 * Strip `system` and `messages` from the SDK's raw request body — those
 * duplicate `attempt.request` (the PromptInput wrap built). What remains is
 * the SDK-added delta: `model`, `max_tokens`, `tools`, `tool_choice`,
 * `response_format`, etc. Returns `undefined` when the body is absent or
 * not an object so the caller can surface a wire_capture_error.
 *
 * Trade-off: `cache_control` markers live on the system blocks, which are
 * stripped here. Cache debugging falls back to `response_wire.usage`.
 */
export function buildWireRequest(raw: unknown): WireRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { system: _s, messages: _m, ...rest } = raw as Record<string, unknown>;
  return { kind: "http", body: rest };
}

/**
 * Pull a `WireCapture` bundle off a `generateText` result. Any thrown error
 * becomes `wire_capture_error` on the capture so the invocation keeps
 * running — logging invariants must never crash the invocation.
 */
function captureFromResult(
  result: unknown,
  raw_response: string | undefined,
  apiKey: string | undefined,
): WireCapture {
  try {
    const r = result as {
      request?: { body?: unknown };
      response?: { body?: unknown };
      usage?: unknown;
      finishReason?: string;
    };
    const rawRequestWire = buildWireRequest(r.request?.body);
    if (!rawRequestWire || rawRequestWire.kind !== "http") {
      return {
        raw_response,
        wire_capture_error: "ai-sdk result.request.body is missing or not an object",
      };
    }
    const requestWire = { kind: "http" as const, body: scrubApiKey(rawRequestWire.body, apiKey) };
    return {
      request_wire: requestWire,
      response_wire: {
        kind: "http",
        body: scrubApiKey(r.response?.body, apiKey),
        usage: r.usage,
        finishReason: r.finishReason,
      },
      raw_response,
    };
  } catch (e) {
    return { wire_capture_error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `openai-compat` speaks Chat Completions (via `@ai-sdk/openai-compatible`)
 * rather than the Responses API — OpenAI's Responses validator rejects
 * multi-turn shapes against non-OpenAI backends (openrouter, groq, …).
 */
export function buildModel(resolved: ResolvedProvider): LanguageModel {
  const { model, name } = resolved;
  if (!model) throw new Error(`LLM error: provider "${name}" has no model.`);
  const reg = getRegistration(name);
  switch (reg.kind) {
    case "anthropic":
      return createAnthropic({
        apiKey: resolveApiKey(resolved.apiKey),
        baseURL: resolved.baseURL,
      })(model);
    case "openai":
      return createOpenAI({
        apiKey: resolveApiKey(resolved.apiKey),
        baseURL: resolved.baseURL,
      })(model);
    case "openai-compat": {
      if (!resolved.baseURL) {
        throw new Error(`LLM error: provider "${name}" requires baseURL.`);
      }
      // Local endpoints (Ollama, LM Studio) skip auth; SDK still needs a
      // Bearer header, so inject a placeholder when no key is configured.
      return createOpenAICompatible({
        name,
        apiKey: resolveApiKey(resolved.apiKey) ?? "nokey",
        baseURL: resolved.baseURL,
        supportsStructuredOutputs: reg.supportsStructuredOutputs,
      })(model);
    }
    case "claude-code":
      throw new Error(`LLM error: "${name}" is a CLI provider, not an AI SDK model.`);
  }
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
  const reg = getRegistration(resolved.name);
  const strictSchema = reg.supportsStructuredOutputs === true;
  const model = buildModel(resolved);
  const resolvedKey = resolveApiKey(resolved.apiKey);

  return {
    runPrompt: async (input, schema?) => {
      if (schema) {
        const outputSchema = strictSchema ? toOpenAIStrictSchema(schema) : schema;
        const result = await generateText({
          model,
          system: input.system,
          messages: input.messages,
          output: Output.object({ schema: outputSchema }),
        });
        const rawResponse = safeStringify(result.output);
        notifications.emit({
          kind: "llm-wire",
          wire: captureFromResult(result, rawResponse, resolvedKey),
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
      notifications.emit({
        kind: "llm-wire",
        wire: captureFromResult(result, result.text, resolvedKey),
      });
      return result.text;
    },
  };
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
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
