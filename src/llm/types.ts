/** Raw LLM call: send any system prompt + user prompt, get a response. */
export type RunPrompt = (
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: Record<string, unknown>,
) => Promise<string>;

/** What initProvider returns: raw call + Wrap's command-translation shorthand. */
export type Provider = {
  runPrompt: RunPrompt;
  runCommandPrompt: (prompt: string, memory?: MemoryFact[]) => Promise<string>;
};

export type MemoryFact = { fact: string };

export type TestProviderConfig = { type: "test" };

export type ClaudeCodeProviderConfig = { type: "claude-code"; model?: string };

export type ProviderConfig = TestProviderConfig | ClaudeCodeProviderConfig;
