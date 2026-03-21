import { claudeCodeProvider } from "./providers/claude-code.ts";
import { testProvider } from "./providers/test.ts";
import type { LLM, ProviderConfig } from "./types.ts";

export type { LLM } from "./types.ts";
export { initLLM };

function initLLM(provider: ProviderConfig): LLM {
  switch (provider.type) {
    case "test":
      return testProvider();
    case "claude-code":
      return claudeCodeProvider(provider);
    default:
      throw new Error(
        `Config error: unrecognized provider "${(provider as { type: string }).type}".`,
      );
  }
}
