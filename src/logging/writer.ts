import { wrapFs } from "../fs/home.ts";
import type { PromptInput } from "../llm/types.ts";
import type { AttemptMeta, LogEntry, WireRequest, WireResponse } from "./entry.ts";
import { serializeEntry } from "./entry.ts";

type TracedAttempt = {
  request?: PromptInput;
  request_wire?: WireRequest;
  response_wire?: WireResponse;
  raw_response?: string;
};

type TraceFile = {
  entry_id: string;
  /** Keyed by turn index — only assistant turns carry attempts. */
  turn_attempts: Record<number, TracedAttempt[]>;
};

function isTraced(attempt: AttemptMeta): boolean {
  return (
    attempt.request !== undefined ||
    attempt.request_wire !== undefined ||
    attempt.response_wire !== undefined
  );
}

// Parse-failure `raw_response` (no request, no wire) stays inline — that's
// the default-config debugging breadcrumb for malformed LLM output.
function extractAttemptTraces(attempt: AttemptMeta): TracedAttempt | null {
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
  const turn_attempts: Record<number, TracedAttempt[]> = {};
  let hasAny = false;
  for (let i = 0; i < entry.turns.length; i++) {
    const turn = entry.turns[i];
    if (turn?.kind !== "assistant") continue;
    const turnHasTraced = turn.attempts.some(isTraced);
    if (!turnHasTraced) continue;
    hasAny = true;
    turn_attempts[i] = turn.attempts.map((a) => extractAttemptTraces(a) ?? {});
  }
  if (!hasAny) return null;
  return { entry_id: entry.id, turn_attempts };
}

/**
 * Appends the entry to wrap.jsonl, then writes a trace sidecar if any
 * assistant turn's attempts carried `logTraces`-mode fields. Mutates `entry`
 * to strip those fields before serialization. JSONL is written first so a
 * sidecar-write failure never costs us the durable record.
 */
export function appendLogEntry(entry: LogEntry): void {
  const trace = extractTraces(entry);
  wrapFs.append("logs/wrap.jsonl", `${serializeEntry(entry)}\n`);
  if (trace) {
    wrapFs.write(`logs/traces/${entry.id}.json`, JSON.stringify(trace));
  }
}
