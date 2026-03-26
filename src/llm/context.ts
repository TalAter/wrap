import type { Fact } from "../memory/types.ts";
import { FEW_SHOT_DEMOS, SCHEMA_TEXT, SYSTEM_PROMPT } from "../prompt.optimized.ts";
import type { ConversationMessage, PromptInput } from "./types.ts";

export type QueryContext = {
  prompt: string;
  cwd: string;
  memory: Fact[];
  threadHistory?: ConversationMessage[];
  pipedInput?: string;
};

/** Assemble a PromptInput for a command prompt call. */
export function assembleCommandPrompt(ctx: QueryContext): PromptInput {
  const systemParts: string[] = [SYSTEM_PROMPT];
  if (SCHEMA_TEXT) {
    systemParts.push(`Respond with a JSON object conforming to this schema:\n${SCHEMA_TEXT}`);
  }

  const messages: ConversationMessage[] = [];

  // Few-shot demos as user/assistant turn pairs
  if (FEW_SHOT_DEMOS.length > 0) {
    for (const demo of FEW_SHOT_DEMOS) {
      messages.push({ role: "user", content: demo.input });
      messages.push({ role: "assistant", content: demo.output });
    }
    messages.push({ role: "user", content: "Now handle the following request." });
  }

  // Final user message: context + prompt
  const sections: string[] = [];

  if (ctx.memory.length > 0) {
    const facts = ctx.memory.map((m) => `- ${m.fact}`).join("\n");
    sections.push(`## Known facts\n${facts}`);
  }

  sections.push(`- Working directory (cwd): ${ctx.cwd}`);
  sections.push(`## User's request\n${ctx.prompt}`);

  messages.push({ role: "user", content: sections.join("\n\n") });

  return { system: systemParts.join("\n\n"), messages };
}
