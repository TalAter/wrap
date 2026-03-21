import { tmpdir } from "node:os";
import type { ClaudeCodeProviderConfig, ProviderConfig } from "../config/config.ts";
import { FEW_SHOT_DEMOS, SCHEMA_TEXT, SYSTEM_PROMPT } from "../prompt.optimized.ts";
import { ResponseJsonSchema } from "../response.schema.ts";

export type LLM = (prompt: string) => Promise<string>;

export function initLLM(provider: ProviderConfig): LLM {
  switch (provider.type) {
    case "test":
      return testProvider();
    case "claude-code":
      return claudeCodeProvider(provider as ClaudeCodeProviderConfig);
    default:
      throw new Error(`Config error: unrecognized provider "${provider.type}".`);
  }
}

function spawnAndRead(cmd: string[], prompt: string, opts?: { cwd?: string }): string {
  const result = Bun.spawnSync(cmd, {
    stdin: Buffer.from(prompt),
    cwd: opts?.cwd,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `${cmd[0]} failed`);
  }
  return result.stdout.toString().trim();
}

const FENCE_RE = /^```\w*\s*\n([\s\S]*)\n```\s*$/;

/** Strip markdown code fences only if the entire response is a single fenced block. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(FENCE_RE);
  if (!match) return trimmed;
  const inner = match[1];
  // If there are more triple backticks inside, this isn't a single clean block
  if (inner.includes("```")) return trimmed;
  return inner.trim();
}

function testProvider(): LLM {
  return async (prompt) => {
    const fixed = process.env.WRAP_TEST_RESPONSE;
    if (fixed) return fixed;
    return JSON.stringify({ type: "command", command: prompt, risk_level: "low" });
  };
}

function assembleSystemPrompt(): string {
  const parts: string[] = [SYSTEM_PROMPT];
  if (SCHEMA_TEXT) {
    parts.push(`Respond with a JSON object conforming to this schema:\n${SCHEMA_TEXT}`);
  }
  if (FEW_SHOT_DEMOS.length > 0) {
    const demosText = FEW_SHOT_DEMOS.map((d) => `User: ${d.input}\nAssistant: ${d.output}`).join(
      "\n\n",
    );
    parts.push(`Examples:\n${demosText}`);
  }
  return parts.join("\n\n");
}

function claudeCodeProvider(config: ClaudeCodeProviderConfig): LLM {
  const model = config.model ?? "haiku";
  const jsonSchema = JSON.stringify(ResponseJsonSchema);

  return async (prompt) =>
    stripFences(
      spawnAndRead(
        [
          "claude",
          "--tools",
          "",
          "--system-prompt",
          assembleSystemPrompt(),
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
      ),
    );
}
