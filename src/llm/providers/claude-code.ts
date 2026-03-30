import { tmpdir } from "node:os";
import { z } from "zod";
import { stripFences } from "../../core/parse-response.ts";
import type { ClaudeCodeProviderConfig, ConversationMessage, Provider } from "../types.ts";
import { spawnAndRead } from "../utils.ts";

/** Flatten conversation messages into a single string for the -p flag. */
function flattenMessages(messages: ConversationMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export function claudeCodeProvider(config: ClaudeCodeProviderConfig): Provider {
  const model = config.model ?? "haiku";

  return {
    runPrompt: async (input, schema?) => {
      const args = [
        "claude",
        "--tools",
        "",
        "--system-prompt",
        input.system,
        "--model",
        model,
        "--no-session-persistence",
        // "--bare" skips config/MCP discovery (10x faster startup) but also
        // skips credential loading, so `claude` exits with "Not logged in".
        // Enable if this is fixed in Claude Code
      ];
      if (schema) {
        args.push("--json-schema", JSON.stringify(z.toJSONSchema(schema)));
      }
      args.push("-p");
      const raw = spawnAndRead(args, flattenMessages(input.messages), { cwd: tmpdir() });
      if (!schema) return raw;
      const cleaned = stripFences(raw);
      return schema.parse(JSON.parse(cleaned));
    },
  };
}
