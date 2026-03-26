import type { CommandResponse } from "../command-response.schema.ts";
import type { AISDKProviderConfig, ProviderConfig } from "../llm/types.ts";
import type { Memory } from "../memory/types.ts";

function redactProvider(provider: ProviderConfig): ProviderConfig {
  if (provider.type !== "anthropic" && provider.type !== "openai") return provider;
  const p = provider as AISDKProviderConfig;
  if (!p.apiKey) return provider;
  const suffix = p.apiKey.length >= 4 ? `...${p.apiKey.slice(-4)}` : "...";
  return { ...p, apiKey: suffix };
}

export type Execution = {
  command: string;
  exit_code: number;
};

export type Round = {
  raw_response?: string;
  parse_error?: string;
  provider_error?: string;
  parsed?: CommandResponse;
  execution?: Execution;
  llm_ms?: number;
  exec_ms?: number;
};

export type LogEntry = {
  id: string;
  timestamp: string;
  prompt: string;
  cwd: string;
  piped_input?: string;
  memory?: Memory;
  provider: ProviderConfig;
  prompt_hash: string;
  rounds: Round[];
  outcome: "success" | "error" | "refused";
};

export function createLogEntry(params: {
  prompt: string;
  cwd: string;
  pipedInput?: string;
  memory?: Memory;
  provider: ProviderConfig;
  promptHash: string;
}): LogEntry {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    prompt: params.prompt,
    cwd: params.cwd,
    provider: redactProvider(params.provider),
    prompt_hash: params.promptHash,
    rounds: [],
    outcome: "error",
  };
  if (params.pipedInput !== undefined) {
    entry.piped_input = params.pipedInput;
  }
  if (params.memory && Object.keys(params.memory).length > 0) {
    entry.memory = params.memory;
  }
  return entry;
}

export function addRound(entry: LogEntry, round: Round): void {
  entry.rounds.push(round);
}

export function serializeEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}
