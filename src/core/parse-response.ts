import { type CommandResponse, CommandResponseSchema } from "../command-response.schema.ts";

/** Sentinel error messages checked by isStructuredOutputError (round.ts). */
export const INVALID_JSON_MSG = "LLM returned invalid JSON.";
export const INVALID_RESPONSE_MSG = "LLM returned an invalid response.";

/** Error carrying the raw LLM text so retry can echo it back for self-correction. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly text: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

const FENCE_RE = /^```\w*\s*\n([\s\S]*)\n```\s*$/;

/** Strip markdown code fences only if the entire response is a single fenced block. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(FENCE_RE);
  if (!match) return trimmed;
  const inner = match[1] ?? "";
  // If there are more triple backticks inside, this isn't a single clean block
  if (inner.includes("```")) return trimmed;
  return inner.trim();
}

export function parseResponse(raw: string): CommandResponse {
  const cleaned = stripFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new Error(INVALID_JSON_MSG);
  }
  const result = CommandResponseSchema.safeParse(json);
  if (!result.success) {
    throw new Error(INVALID_RESPONSE_MSG);
  }
  return result.data;
}
