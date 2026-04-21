import { type CommandResponse, CommandResponseSchema } from "../command-response.schema.ts";
import { aiSdkProvider } from "./providers/ai-sdk.ts";
import { claudeCodeProvider } from "./providers/claude-code.ts";
import { getRegistration } from "./providers/registry.ts";
import { testProvider } from "./providers/test.ts";
import type { PromptInput, Provider, ResolvedProvider } from "./types.ts";

export type { PromptInput, Provider, ResolvedProvider } from "./types.ts";
export { initProvider, runCommandPrompt };

/**
 * Dispatch a `ResolvedProvider` to the right SDK factory. The test sentinel
 * is special-cased; everything else routes through the registry's `kind`.
 * See specs/llm.md.
 */
function initProvider(resolved: ResolvedProvider): Provider {
  if (resolved.name === "test") return testProvider();
  switch (getRegistration(resolved.name).kind) {
    case "claude-code":
      return claudeCodeProvider(resolved);
    case "anthropic":
    case "openai":
    case "openai-compat":
      return aiSdkProvider(resolved);
  }
}

/** Convenience: call runPrompt with CommandResponseSchema and return typed result. */
function runCommandPrompt(provider: Provider, input: PromptInput): Promise<CommandResponse> {
  return provider.runPrompt(input, CommandResponseSchema) as Promise<CommandResponse>;
}
