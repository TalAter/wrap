import { claudeCodeProvider } from "./providers/claude-code.ts";
import { testProvider } from "./providers/test.ts";
import type { Provider, ProviderConfig } from "./types.ts";

export type { Provider, ProviderConfig } from "./types.ts";
export { initProvider };

function initProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "test":
      return testProvider();
    case "claude-code":
      return claudeCodeProvider(config);
    default:
      throw new Error(
        `Config error: unrecognized provider "${(config as { type: string }).type}".`,
      );
  }
}
