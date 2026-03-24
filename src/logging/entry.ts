import type { CommandResponse } from "../command-response.schema.ts";
import type { ProviderConfig } from "../llm/types.ts";

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
};

export type LogEntry = {
  id: string;
  timestamp: string;
  prompt: string;
  cwd: string;
  piped_input?: string;
  provider: ProviderConfig;
  prompt_hash: string;
  rounds: Round[];
  outcome: "success" | "error" | "refused";
};

export function createLogEntry(params: {
  prompt: string;
  cwd: string;
  pipedInput?: string;
  provider: ProviderConfig;
  promptHash: string;
}): LogEntry {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    prompt: params.prompt,
    cwd: params.cwd,
    provider: params.provider,
    prompt_hash: params.promptHash,
    rounds: [],
    outcome: "error",
  };
  if (params.pipedInput !== undefined) {
    entry.piped_input = params.pipedInput;
  }
  return entry;
}

export function addRound(entry: LogEntry, round: Round): void {
  entry.rounds.push(round);
}

export function serializeEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}
