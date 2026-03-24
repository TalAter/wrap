import { type CommandResponse, CommandResponseSchema } from "../command-response.schema.ts";
import { aiSdkProvider } from "./providers/ai-sdk.ts";
import { claudeCodeProvider } from "./providers/claude-code.ts";
import { testProvider } from "./providers/test.ts";
import type { PromptInput, Provider, ProviderConfig } from "./types.ts";

export type { PromptInput, Provider, ProviderConfig } from "./types.ts";
export { initProvider, runCommandPrompt };

function initProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
    case "openai":
      return aiSdkProvider(config);
    case "claude-code":
      return claudeCodeProvider(config);
    case "test":
      return testProvider();
    default:
      throw new Error(
        `Config error: unrecognized provider "${(config as { type: string }).type}".`,
      );
  }
}

/** Convenience: call runPrompt with CommandResponseSchema and return typed result. */
function runCommandPrompt(provider: Provider, input: PromptInput): Promise<CommandResponse> {
  return provider.runPrompt(input, CommandResponseSchema) as Promise<CommandResponse>;
}
