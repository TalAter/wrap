import pkg from "../../package.json";
import type { CommandResponse } from "../command-response.schema.ts";
import type { ResolvedProvider } from "../llm/types.ts";
import type { Memory } from "../memory/types.ts";

function redactProvider(provider: ResolvedProvider): ResolvedProvider {
  if (!provider.apiKey) return provider;
  const suffix = provider.apiKey.length >= 4 ? `...${provider.apiKey.slice(-4)}` : "...";
  return { ...provider, apiKey: suffix };
}

export type Execution = {
  command: string;
  exit_code: number;
  shell: string;
};

export type Round = {
  raw_response?: string;
  parse_error?: string;
  provider_error?: string;
  parsed?: CommandResponse;
  execution?: Execution;
  llm_ms?: number;
  exec_ms?: number;
  /**
   * The user's follow-up text that triggered this round, set only on the
   * FIRST round produced by a follow-up call. Subsequent rounds in the same
   * call (e.g. probe → command) leave it unset so the log can faithfully
   * reconstruct which user message kicked off which sequence. The very first
   * user turn of the entry is NOT a follow-up — it lives on `LogEntry.prompt`.
   */
  followup_text?: string;
};

export type LogEntry = {
  id: string;
  timestamp: string;
  version: string;
  prompt: string;
  cwd: string;
  piped_input?: string;
  memory?: Memory;
  provider: ResolvedProvider;
  prompt_hash: string;
  rounds: Round[];
  outcome: "success" | "error" | "blocked" | "cancelled" | "max_rounds";
};

export function createLogEntry(params: {
  prompt: string;
  cwd: string;
  pipedInput?: string;
  memory?: Memory;
  provider: ResolvedProvider;
  promptHash: string;
}): LogEntry {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    version: pkg.version,
    prompt: params.prompt,
    cwd: params.cwd,
    provider: redactProvider(params.provider),
    prompt_hash: params.promptHash,
    rounds: [],
    outcome: "error",
  };
  if (params.pipedInput !== undefined) {
    const LOG_PIPED_INPUT_MAX = 1000;
    entry.piped_input =
      params.pipedInput.length > LOG_PIPED_INPUT_MAX
        ? `${params.pipedInput.slice(0, LOG_PIPED_INPUT_MAX)}\n[…truncated, ${params.pipedInput.length} chars total]`
        : params.pipedInput;
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
