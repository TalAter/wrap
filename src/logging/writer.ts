import { appendWrapFile, writeWrapFile } from "../fs/home.ts";
import type { PromptInput } from "../llm/types.ts";
import type { Attempt, LogEntry, WireRequest, WireResponse } from "./entry.ts";
import { serializeEntry } from "./entry.ts";

type TracedAttempt = {
  request?: PromptInput;
  request_wire?: WireRequest;
  response_wire?: WireResponse;
  raw_response?: string;
};

type TraceFile = {
  entry_id: string;
  rounds: { attempts: TracedAttempt[] }[];
};

function isTraced(attempt: Attempt): boolean {
  return (
    attempt.request !== undefined ||
    attempt.request_wire !== undefined ||
    attempt.response_wire !== undefined
  );
}

// Parse-failure `raw_response` (no request, no wire) stays inline — that's
// the default-config debugging breadcrumb for malformed LLM output.
function extractAttemptTraces(attempt: Attempt): TracedAttempt | null {
  if (!isTraced(attempt)) return null;
  const traced: TracedAttempt = {};
  if (attempt.request !== undefined) {
    traced.request = attempt.request;
    delete attempt.request;
  }
  if (attempt.request_wire !== undefined) {
    traced.request_wire = attempt.request_wire;
    delete attempt.request_wire;
  }
  if (attempt.response_wire !== undefined) {
    traced.response_wire = attempt.response_wire;
    delete attempt.response_wire;
  }
  if (attempt.raw_response !== undefined) {
    traced.raw_response = attempt.raw_response;
    delete attempt.raw_response;
  }
  return traced;
}

function extractTraces(entry: LogEntry): TraceFile | null {
  let hasAny = false;
  for (const round of entry.rounds) {
    for (const attempt of round.attempts) {
      if (isTraced(attempt)) {
        hasAny = true;
        break;
      }
    }
    if (hasAny) break;
  }
  if (!hasAny) return null;
  const rounds = entry.rounds.map((round) => ({
    attempts: round.attempts.map((a) => extractAttemptTraces(a) ?? {}),
  }));
  return { entry_id: entry.id, rounds };
}

/**
 * Appends the entry to wrap.jsonl, then writes a trace sidecar if any attempt
 * carried `logTraces`-mode fields. Mutates `entry` to strip those fields
 * before serialization. JSONL is written first so a sidecar-write failure
 * never costs us the durable record.
 */
export function appendLogEntry(wrapHome: string, entry: LogEntry): void {
  const trace = extractTraces(entry);
  appendWrapFile("logs/wrap.jsonl", `${serializeEntry(entry)}\n`, wrapHome);
  if (trace) {
    writeWrapFile(`logs/traces/${entry.id}.json`, JSON.stringify(trace), wrapHome);
  }
}
