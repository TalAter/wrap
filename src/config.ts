export type ProviderConfig = { type: string };

export type ClaudeCodeProviderConfig = ProviderConfig & {
  type: "claude-code";
  model?: string;
};

export type Config = {
  provider?: ProviderConfig;
};

export function loadConfig(envOverrides: Record<string, string | undefined> = {}): Config {
  const env = { ...process.env, ...envOverrides };
  const raw = env.WRAP_CONFIG?.trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Config error: WRAP_CONFIG contains invalid JSON.");
    }
  }
  return {};
}
