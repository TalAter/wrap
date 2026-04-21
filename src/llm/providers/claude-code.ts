import { tmpdir } from "node:os";
import { z } from "zod";
import { notifications } from "../../core/notify.ts";
import {
  INVALID_JSON_MSG,
  INVALID_RESPONSE_MSG,
  StructuredOutputError,
  stripFences,
} from "../../core/parse-response.ts";
import { scrubApiKey } from "../../logging/entry.ts";
import type { ConversationMessage, Provider, ResolvedProvider } from "../types.ts";
import { spawnAndRead } from "../utils.ts";

/** Flatten conversation messages into a single string for the -p flag. */
function flattenMessages(messages: ConversationMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export function claudeCodeProvider(resolved: ResolvedProvider): Provider {
  const model = resolved.model;

  return {
    runPrompt: async (input, schema?) => {
      const args = [
        "claude",
        "--tools",
        "",
        "--system-prompt",
        input.system,
        ...(model ? ["--model", model] : []),
        "--no-session-persistence",
        // "--bare" skips config/MCP discovery (10x faster startup) but also
        // skips credential loading, so `claude` exits with "Not logged in".
        // Enable if this is fixed in Claude Code
      ];
      if (schema) {
        args.push("--json-schema", JSON.stringify(z.toJSONSchema(schema)));
      }
      args.push("-p");
      const stdin = flattenMessages(input.messages);
      const { stdout, stderr, exit_code } = await spawnAndRead(args, stdin, { cwd: tmpdir() });
      const apiKey = resolved.apiKey;
      notifications.emit({
        kind: "llm-wire",
        wire: {
          request_wire: {
            kind: "subprocess",
            argv: scrubApiKey(args, apiKey),
            stdin: scrubApiKey(stdin, apiKey),
          },
          response_wire: {
            kind: "subprocess",
            stdout: scrubApiKey(stdout, apiKey),
            exit_code,
            ...(stderr ? { stderr: scrubApiKey(stderr, apiKey) } : {}),
          },
          raw_response: scrubApiKey(stdout, apiKey),
        },
      });
      if (exit_code !== 0) {
        throw new Error(stderr.trim() || `${args[0]} failed`);
      }
      const raw = stdout.trim();
      if (!schema) return raw;
      const cleaned = stripFences(raw);
      let json: unknown;
      try {
        json = JSON.parse(cleaned);
      } catch {
        throw new StructuredOutputError(INVALID_JSON_MSG, cleaned);
      }
      const result = schema.safeParse(json);
      if (!result.success) {
        throw new StructuredOutputError(INVALID_RESPONSE_MSG, cleaned);
      }
      return result.data;
    },
  };
}
