import type { Memory } from "../memory/types.ts";
import {
  CWD_PREFIX,
  FEW_SHOT_EXAMPLES,
  FEW_SHOT_SEPARATOR,
  MEMORY_RECENCY_INSTRUCTION,
  PIPED_INSTRUCTION,
  SCHEMA_INSTRUCTION,
  SCHEMA_TEXT,
  SECTION_DETECTED_TOOLS,
  SECTION_FACTS_ABOUT,
  SECTION_SYSTEM_FACTS,
  SECTION_USER_REQUEST,
  SYSTEM_PROMPT,
  TOOLS_SCOPE_INSTRUCTION,
  VOICE_INSTRUCTIONS,
} from "../prompt.optimized.ts";
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
  const systemParts: string[] = [
    SYSTEM_PROMPT,
    MEMORY_RECENCY_INSTRUCTION,
    TOOLS_SCOPE_INSTRUCTION,
    VOICE_INSTRUCTIONS,
  ];
  if (SCHEMA_TEXT) {
    systemParts.push(`${SCHEMA_INSTRUCTION}\n${SCHEMA_TEXT}`);
  }

  const messages: ConversationMessage[] = [];

  // Few-shot examples as user/assistant turn pairs
  if (FEW_SHOT_EXAMPLES.length > 0) {
    for (const example of FEW_SHOT_EXAMPLES) {
      messages.push({ role: "user", content: example.input });
      messages.push({ role: "assistant", content: example.output });
    }
    messages.push({ role: "user", content: FEW_SHOT_SEPARATOR });
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
    const header = scope === "/" ? SECTION_SYSTEM_FACTS : `${SECTION_FACTS_ABOUT} ${scope}`;
    sections.push(`${header}\n${facts.map((f) => `- ${f.fact}`).join("\n")}`);
  }

  if (ctx.toolsOutput) {
    sections.push(`${SECTION_DETECTED_TOOLS}\n${ctx.toolsOutput}`);
  }

  if (ctx.piped) {
    sections.push(PIPED_INSTRUCTION);
  }

  sections.push(`${CWD_PREFIX} ${ctx.cwd}`);
  sections.push(`${SECTION_USER_REQUEST}\n${ctx.prompt}`);

  messages.push({ role: "user", content: sections.join("\n\n") });

  return { system: systemParts.join("\n\n"), messages };
}
