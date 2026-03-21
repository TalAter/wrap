export type LLM = (prompt: string) => Promise<string>;

export type TestProviderConfig = { type: "test" };

export type ClaudeCodeProviderConfig = { type: "claude-code"; model?: string };

export type ProviderConfig = TestProviderConfig | ClaudeCodeProviderConfig;
