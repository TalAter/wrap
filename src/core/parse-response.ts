import { type Response, ResponseSchema } from "../response.schema.ts";

export function parseResponse(raw: string): Response {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("LLM returned invalid JSON.");
  }
  const result = ResponseSchema.safeParse(json);
  if (!result.success) {
    throw new Error("LLM returned an invalid response.");
  }
  return result.data;
}
