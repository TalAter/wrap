import { tmpdir } from "node:os";
import { assemblePromptParts } from "../../prompt.ts";
import { ResponseJsonSchema } from "../../response.schema.ts";
import type { ClaudeCodeProviderConfig, MemoryFact, Provider } from "../types.ts";
import { spawnAndRead } from "../utils.ts";

function buildSystemPrompt(memory?: MemoryFact[]): string {
  const parts = assemblePromptParts();
  const sections: string[] = [parts.system];
  if (memory && memory.length > 0) {
    const facts = memory.map((m) => `- ${m.fact}`).join("\n");
    sections.push(`## Known facts about the user's environment\n${facts}`);
  }
  if (parts.schema) {
    sections.push(`Respond with a JSON object conforming to this schema:\n${parts.schema}`);
  }
  if (parts.fewShotDemos && parts.fewShotDemos.length > 0) {
    const demosText = parts.fewShotDemos
      .map((d) => `User: ${d.input}\nAssistant: ${d.output}`)
      .join("\n\n");
    sections.push(`Examples:\n${demosText}`);
  }
  return sections.join("\n\n");
}

export function claudeCodeProvider(config: ClaudeCodeProviderConfig): Provider {
  const model = config.model ?? "haiku";

  const runPrompt: Provider["runPrompt"] = async (systemPrompt, userPrompt, jsonSchema) => {
    const args = [
      "claude",
      "--tools",
      "",
      "--system-prompt",
      systemPrompt,
      "--model",
      model,
      "--no-session-persistence",
    ];
    if (jsonSchema) {
      args.push("--json-schema", JSON.stringify(jsonSchema));
    }
    args.push("-p");
    return spawnAndRead(args, userPrompt, { cwd: tmpdir() });
  };

  const runCommandPrompt: Provider["runCommandPrompt"] = (prompt, memory) =>
    runPrompt(buildSystemPrompt(memory), prompt, ResponseJsonSchema);

  return { runPrompt, runCommandPrompt };
}
