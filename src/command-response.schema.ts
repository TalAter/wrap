import { z } from "zod";

// Everything between SCHEMA_START and SCHEMA_END is extracted as raw text and
// embedded in the LLM prompt by DSPy (via eval/dspy/read_schema.py). All schema
// definitions must live within these markers. Inline comments are intentional —
// they guide the LLM on how to use each field and are read on every request.
// SCHEMA_START
export const CommandResponseSchema = z.object({
  // _scratchpad: Brief plan (1-3 sentences). Use this for your thinking —
  // it will not be shown to the user. Required for any non-trivial
  // request — including anything that modifies, deletes, or destroys
  // files or state. Skip for trivial read-only commands (ls, pwd, date).
  _scratchpad: z.string().nullable().optional(),
  type: z.enum([
    // command = a shell command to execute. Combined with `final`, this covers both terminal actions and intermediate discovery steps (see the `final` field).
    "command",
    // reply = a direct text response. Use for general knowledge questions that don't need a shell command.
    "reply",
  ]),
  // false = intermediate step; the command is executed and its captured
  // output is fed back to you next round. Use this when you need to discover
  // something about the user's environment or stage an artifact in
  // $WRAP_TEMP_DIR before deciding the final action. Only valid for `command`
  // — replies are always terminal.
  // true (default) = terminal; the command runs with inherited stdio (user
  // sees output) or the reply prints.
  final: z.boolean().default(true),
  // Cross-round intent. Required when `final` is false — a one-sentence
  // description of the whole chain (e.g. "download, inspect, then run from
  // the temp dir"). Shown to the user in the dialog and echoed back to you
  // next round so each step stays coherent with the original plan. Leave
  // null/omit for terminal responses.
  plan: z.string().nullable().optional(),
  // The shell command (for command) or text response (for reply)
  content: z.string(),
  // low = read-only/safe, medium = modifies files or state, high = destructive or irreversible
  risk_level: z.enum(["low", "medium", "high"]),
  // Brief description of what the command does or why this answer was given.
  // Will be shown to the user. Never use to think.
  explanation: z.string().nullable().optional(),
  // Reusable facts learned about the user's environment.
  // These are saved and given to you in future requests.
  // Only remember facts that will be helpful in the future — not one-off requests,
  // user actions, or ephemeral events (e.g. "user asked to delete X").
  // Only record facts already true — never facts that assume the command in this response will succeed.
  memory_updates: z
    .array(
      z.object({
        // The fact to remember
        fact: z.string(),
        // Absolute directory path this fact applies to.
        // Use "/" for system-wide facts (installed tools, OS, shell).
        // Use the project's root directory for project-specific facts
        // (tooling, test commands, build systems).
        // Default to "/" unless the fact is clearly project-specific.
        scope: z.string(),
      }),
    )
    .nullable()
    .optional(),
  // Human-readable summary of what learning was saved to memory. Will be shown to the user
  memory_updates_message: z.string().nullable().optional(),
  // Tool names to add to the persistent watchlist.
  // Checked on every future invocation.
  // When probing for tool availability, include ALL well-known tools
  // for this task on this OS to be added to the watchlist — not just the one you plan to use.
  // This gives balanced visibility into what's installed.
  // When returning a command that installs a tool, use watchlist_additions instead of
  // memory_updates to note that tool and others in the category.
  watchlist_additions: z.array(z.string()).nullable().optional(),
});
// SCHEMA_END

export type CommandResponse = z.infer<typeof CommandResponseSchema>;
export type RiskLevel = CommandResponse["risk_level"];

export const CommandResponseJsonSchema = z.toJSONSchema(CommandResponseSchema);
