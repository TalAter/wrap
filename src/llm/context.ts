import type { Memory } from "../memory/types.ts";
import { FEW_SHOT_EXAMPLES, SCHEMA_TEXT, SYSTEM_PROMPT } from "../prompt.optimized.ts";
import type { ConversationMessage, PromptInput } from "./types.ts";

export type QueryContext = {
  prompt: string;
  cwd: string;
  memory: Memory;
  threadHistory?: ConversationMessage[];
  pipedInput?: string;
  toolsOutput?: string;
  piped?: boolean;
};

/** Assemble a PromptInput for a command prompt call. */
export function assembleCommandPrompt(ctx: QueryContext): PromptInput {
  const systemParts: string[] = [SYSTEM_PROMPT];
  if (SCHEMA_TEXT) {
    systemParts.push(`Respond with a JSON object conforming to this schema:\n${SCHEMA_TEXT}`);
  }
  if (ctx.piped) {
    systemParts.push(
      "stdout is being piped to another program. For answer-type responses: return the bare value with no prose, no commentary, no personality. If the answer is a number, return just the number with no thousands separators or formatting. If it's a name, return just the name. Only add minimal prose when the answer genuinely can't be reduced to a bare value.",
    );
  }

  const messages: ConversationMessage[] = [];

  // Few-shot examples as user/assistant turn pairs
  if (FEW_SHOT_EXAMPLES.length > 0) {
    for (const example of FEW_SHOT_EXAMPLES) {
      messages.push({ role: "user", content: example.input });
      messages.push({ role: "assistant", content: example.output });
    }
    messages.push({ role: "user", content: "Now handle the following request." });
  }

  // Final user message: context + prompt
  const sections: string[] = [];

  // Filter memory scopes by CWD prefix match, in stored key order (alphabetical = global → specific)
  const cwdSlash = ctx.cwd.endsWith("/") ? ctx.cwd : `${ctx.cwd}/`;
  for (const scope of Object.keys(ctx.memory)) {
    const scopeSlash = scope.endsWith("/") ? scope : `${scope}/`;
    if (!cwdSlash.startsWith(scopeSlash)) continue;
    const facts = ctx.memory[scope];
    if (!facts || facts.length === 0) continue;
    const header = scope === "/" ? "## System facts" : `## Facts about ${scope}`;
    sections.push(`${header}\n${facts.map((f) => `- ${f.fact}`).join("\n")}`);
  }

  if (ctx.toolsOutput) {
    sections.push(`## Tools available in current directory\n${ctx.toolsOutput}`);
  }

  sections.push(`- Working directory (cwd): ${ctx.cwd}`);
  sections.push(`## User's request\n${ctx.prompt}`);

  messages.push({ role: "user", content: sections.join("\n\n") });

  return { system: systemParts.join("\n\n"), messages };
}
