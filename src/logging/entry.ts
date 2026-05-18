import pkg from "../../package.json";
import type { CommandResponse } from "../command-response.schema.ts";
import type { PromptInput, ResolvedProvider } from "../llm/types.ts";
import type { Memory } from "../memory/types.ts";

function redactProvider(provider: ResolvedProvider): ResolvedProvider {
  if (!provider.apiKey) return provider;
  const suffix = provider.apiKey.length >= 4 ? `...${provider.apiKey.slice(-4)}` : "...";
  return { ...provider, apiKey: suffix };
}

/**
 * Defensive scan — replace every occurrence of `apiKey` inside any string
 * field of `body` (an object/array payload) with its redacted form. Meant
 * to catch the theoretical case where a provider serializes the key into
 * the request body. The primary redaction already happens at the
 * ResolvedProvider layer; this is belt-and-braces.
 *
 * Skips when `apiKey` is short enough that substring matching would be
 * unsafe (< 8 chars — common noise). Returns the input unchanged if
 * `body` is null/undefined.
 */
export function scrubApiKey<T>(body: T, apiKey: string | undefined): T {
  if (body == null) return body;
  if (!apiKey || apiKey.length < 8) return body;
  const replacement = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "...";
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.includes(apiKey) ? node.split(apiKey).join(replacement) : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(body) as T;
}

/**
 * Wire-level capture of a single LLM physical call. Only populated when
 * `logTraces` is enabled. Each shape is a discriminated union keyed on the
 * transport the provider uses.
 */
export type WireRequest =
  | { kind: "http"; body: unknown }
  | { kind: "subprocess"; argv: string[]; stdin: string }
  | { kind: "test" };

export type WireResponse =
  | { kind: "http"; body: unknown; usage?: unknown; finishReason?: string }
  | { kind: "subprocess"; stdout: string; stderr?: string; exit_code: number }
  | { kind: "test" };

/**
 * Bundle emitted by a provider after every physical LLM call. `runRound`
 * subscribes to the notification bus and drains one WireCapture per attempt.
 * A broken wire-builder surfaces as `wire_capture_error`; the invocation
 * still succeeds.
 */
export type WireCapture = {
  request_wire?: WireRequest;
  response_wire?: WireResponse;
  raw_response?: string;
  wire_capture_error?: string;
};

/**
 * Categorical error reported per AttemptMeta. Parsing failures, provider
 * errors, and empty-content responses are distinct enough that consumers
 * want to discriminate without string-matching a free-text message.
 */
export type AttemptError =
  | { kind: "parse"; message: string }
  | { kind: "provider"; message: string }
  | { kind: "empty"; message: string };

/**
 * One physical LLM call inside an `assistant` turn. Up to four per turn:
 * initial → json-retry → scratchpad-retry → json-retry of the scratchpad.
 * Every successful ladder appends at least one.
 *
 * Detail-mode-gated fields (`request`, `request_wire`, `response_wire`) are
 * only populated when the user opts in via `logTraces`. `raw_response` keeps
 * its always-on-parse-failure behavior plus always-on-success when
 * `logTraces` is on. The trace fields are extracted to a sidecar at write
 * time; the on-disk JSONL stays lean.
 */
export type AttemptMeta = {
  /**
   * The parsed response from this specific physical call. Forensic detail —
   * lets the log show, e.g., that the first scratchpad attempt came back
   * null before the retry. The canonical post-ladder response is on the
   * containing assistant turn, not here.
   */
  parsed?: CommandResponse;
  request?: PromptInput;
  request_wire?: WireRequest;
  raw_response?: string;
  response_wire?: WireResponse;
  error?: AttemptError;
  wire_capture_error?: string;
  llm_ms?: number;
};

/**
 * Semantic conversation turn. The LogEntry's `turns[]` and the runtime
 * transcript are the same array — one shape, two consumers (the JSONL
 * writer and the LLM projector).
 */
export type Turn =
  /**
   * A user message — the initial query (first user turn) or a follow-up
   * typed into the dialog. Stored as bare text; framing (context,
   * sectionUserRequest) is applied at projection time only.
   */
  | { kind: "user"; text: string }
  /**
   * One LLM round. `response` is the last successful parse (absent only
   * when every attempt in the round failed). `attempts[]` enumerates every
   * physical LLM call including failures, for forensic use.
   */
  | {
      kind: "assistant";
      response?: CommandResponse;
      attempts: AttemptMeta[];
      llm_ms?: number;
    }
  /**
   * A non-final execution: an inline low-risk step run by the runner OR a
   * med/high step the user confirmed via the dialog. `command` is the
   * executed bytes (may differ from the prior assistant turn's
   * `response.content` on `user_override`). `output` is post-truncation
   * captured stdout+stderr.
   */
  | {
      kind: "step";
      command: string;
      exit_code: number;
      output: string;
      shell: string;
      source: "model" | "user_override";
      exec_ms?: number;
    }
  /**
   * Session's final outcome. Exactly one per session, pushed at session end
   * for every outcome other than pure-answer. Pure-answer sessions have no
   * `final` turn (the answer is the last assistant turn).
   *
   * - `model` / `user_override`: actual execution; `exit_code` set.
   * - `cancelled` / `blocked`: user cancelled or rule blocked; `command`
   *   is the proposed bytes, `exit_code` null.
   * - `exhausted` / `error`: budget hit or unrecoverable error; `command`
   *   is the last LLM-proposed bytes (else empty), `exit_code` null.
   */
  | {
      kind: "final";
      command: string;
      exit_code: number | null;
      shell?: string;
      source: "model" | "user_override" | "cancelled" | "blocked" | "exhausted" | "error";
      exec_ms?: number;
    }
  /**
   * Continuation only: cwd changed between the parent invocation and the
   * child. Never appears in a single-invocation entry.
   */
  | { kind: "cwd_change"; from: string; to: string };

/**
 * Convenience alias for the assistant Turn variant. `runRound` builds and
 * returns one of these; the runner pushes it directly onto `entry.turns`.
 */
export type AssistantTurn = Extract<Turn, { kind: "assistant" }>;

export type LogEntry = {
  id: string;
  timestamp: string;
  version: string;
  cwd: string;
  /** `process.ppid` at session start. Stamped on every entry. */
  ppid: number;
  /**
   * Set by continuation when this entry resumes another. Always absent
   * outside the continuation path.
   */
  parent_id?: string;
  /**
   * Recorded when stdin was piped.
   * - `path` is ephemeral — the per-invocation temp dir is removed by the OS
   *   on its own schedule. Useful for debugging against contemporaneous env
   *   logs; log consumers should not assume the file still exists.
   * - `size` is raw byte count.
   * - `preview` is UTF-8 decoded text (possibly truncated to 1000 chars in
   *   the log; binary content renders as a short summary). `size` and
   *   `preview.length` will disagree for binary and truncated content.
   */
  attached_input?: {
    path: string;
    size: number;
    preview: string;
  };
  memory?: Memory;
  provider: ResolvedProvider;
  prompt_hash: string;
  /**
   * Semantic conversation: user / assistant / step / final / cwd_change.
   * This is the runtime transcript and the durable log — one shape.
   */
  turns: Turn[];
  outcome: "success" | "error" | "blocked" | "cancelled" | "max_rounds";
  /** How the prompt arrived: argv (default), pipe (stdin), or tui (the
   *  interactive composer). Absent entries predate this field and should be
   *  treated as "argv" by consumers. */
  input_source?: "argv" | "pipe" | "tui";
};

export function createLogEntry(params: {
  cwd: string;
  attachedInputPath?: string;
  attachedInputSize?: number;
  attachedInputPreview?: string;
  memory?: Memory;
  provider: ResolvedProvider;
  promptHash: string;
  inputSource?: "argv" | "pipe" | "tui";
  /** Override for `process.ppid` — only used by tests. */
  ppid?: number;
}): LogEntry {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    version: pkg.version,
    cwd: params.cwd,
    ppid: params.ppid ?? process.ppid,
    provider: redactProvider(params.provider),
    prompt_hash: params.promptHash,
    turns: [],
    outcome: "error",
  };
  if (
    params.attachedInputPath !== undefined &&
    params.attachedInputSize !== undefined &&
    params.attachedInputPreview !== undefined
  ) {
    const LOG_PREVIEW_MAX = 1000;
    const preview =
      params.attachedInputPreview.length > LOG_PREVIEW_MAX
        ? `${params.attachedInputPreview.slice(0, LOG_PREVIEW_MAX)}\n[…truncated, ${params.attachedInputPreview.length} chars total]`
        : params.attachedInputPreview;
    entry.attached_input = {
      path: params.attachedInputPath,
      size: params.attachedInputSize,
      preview,
    };
  }
  if (params.memory && Object.keys(params.memory).length > 0) {
    entry.memory = params.memory;
  }
  if (params.inputSource !== undefined) entry.input_source = params.inputSource;
  return entry;
}

export function serializeEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}
