import { tmpdir } from "node:os";
import { assemblePromptParts } from "../../prompt.ts";
import { ResponseJsonSchema } from "../../response.schema.ts";
import type { ClaudeCodeProviderConfig, LLM } from "../types.ts";
import { spawnAndRead } from "../utils.ts";

function buildSystemPrompt(): string {
  const parts = assemblePromptParts();
  const sections: string[] = [parts.system];
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

export function claudeCodeProvider(config: ClaudeCodeProviderConfig): LLM {
  const model = config.model ?? "haiku";
  const jsonSchema = JSON.stringify(ResponseJsonSchema);

  return async (prompt) =>
    spawnAndRead(
      [
        "claude",
        "--tools",
        "",
        "--system-prompt",
        buildSystemPrompt(),
        "--json-schema",
        jsonSchema,
        "--model",
        model,
        "--no-session-persistence",
        "-p",
      ],
      prompt,
      // Avoid running from Wrap's own project dir, which would load CLAUDE.md.
      // Temp dir is imperfect (has files) but tools are disabled so claude can't read them.
      { cwd: tmpdir() },
    );
}
