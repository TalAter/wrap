import { z } from "zod";

// Everything between SCHEMA_START and SCHEMA_END is extracted as raw text and
// embedded in the LLM prompt by DSPy (via eval/dspy/read_schema.py). All schema
// definitions must live within these markers. Inline comments are intentional —
// they guide the LLM on how to use each field and are read on every request.
// SCHEMA_START
export const ResponseSchema = z.object({
  type: z.enum([
    // command = shell command to execute. Use when you know what command to run to achieve the user's request.
    "command",
    // probe = a safe, read-only discovery command to learn about the user's environment (e.g. what shell they use, what's installed). The probe output will be fed back to you in a follow-up request so you can then produce the final command.
    "probe",
    // answer = a direct text response. Use for general knowledge questions that don't need a shell command.
    "answer",
  ]),
  // The shell command to execute (for command and probe types)
  command: z.string().optional(),
  // Text response to the user (for answer type)
  answer: z.string().optional(),
  // low = read-only/safe, medium = modifies files or state, high = destructive or irreversible
  risk_level: z.enum(["low", "medium", "high"]),
  // Brief description of what the command does or why this answer was given
  explanation: z.string().optional(),
  // Reusable facts learned about the user's environment (e.g. shell type, OS, installed tools). These will be saved and given to you in all future requests
  memory_updates: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
  // Human-readable summary of what learning was saved to memory. Will be shown to the user
  memory_updates_message: z.string().optional(),
});
// SCHEMA_END

export type Response = z.infer<typeof ResponseSchema>;

export const ResponseJsonSchema = z.toJSONSchema(ResponseSchema);
