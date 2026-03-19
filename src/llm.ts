import { tmpdir } from "node:os";
import type { ClaudeCodeProviderConfig, ProviderConfig } from "./config.ts";

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

function testProvider(): LLM {
  return async (prompt) => spawnAndRead(["cat"], prompt);
}

function claudeCodeProvider(config: ClaudeCodeProviderConfig): LLM {
  const model = config.model ?? "haiku";
  const systemPrompt =
    "You are a shell command expert. The user describes what they want to do. Respond with ONLY the shell command that does it — no explanation, no markdown, no code fences. If the request is a question that doesn't map to a CLI command, answer it briefly in plain text.";

  return async (prompt) =>
    spawnAndRead(
      [
        "claude",
        "--output-format",
        "json",
        "--tools",
        "",
        "--system-prompt",
        systemPrompt,
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
