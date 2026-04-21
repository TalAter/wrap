---
name: log-traces
description: Opt-in capture of full LLM prompts + responses (and wire-level bodies) in the invocation log
status: planned
---

# Log traces

Opt-in detailed logging. When `logTraces` is on, every round's full `PromptInput` (system + messages as built by wrap) and wire-level request/response body from the SDK (or subprocess argv/stdin/stdout for CLI providers) are captured inline in `wrap.jsonl`. Default off.

Purpose: debug prompt-construction bugs, SDK-translation bugs, cache misses, token-usage regressions, and eval-on-a-real-trace workflows.

## Setting

New entry in `src/config/settings.ts`:

```ts
logTraces: {
  type: "boolean",
  description:
    "Capture full LLM prompts and wire-level responses in the invocation log. Off by default.",
  usage: "w --log-traces",
  flag: ["--log-traces"],
  env: ["WRAP_LOG_TRACES"],
  default: false,
},
```

- CLI: `--log-traces`
- Env: `WRAP_LOG_TRACES=1`
- Config: `{ "logTraces": true }` in `~/.wrap/config.jsonc`
- Matching property in `src/config/config.schema.json`.

Precedence follows the standard resolver (flag > env > file > default). Resolved once at session start.

Not surfaced in the first-run wizard.

## Log shape changes

### Round — new canonical shape

`attempts[]` = canonical call record. One entry per physical LLM call. Up to **four** per round today: initial call → json-retry → scratchpad-retry → scratchpad's json-retry (the scratchpad path wraps another `callWithRetry`). Always at least one attempt.

```ts
type AttemptError =
  | { kind: "parse"; message: string }
  | { kind: "provider"; message: string }
  | { kind: "empty"; message: string };

type Attempt = {
  request?: PromptInput;            // logTraces on
  request_wire?: WireRequest;       // logTraces on
  raw_response?: string;            // always on parse failure; also on success when logTraces on
  response_wire?: WireResponse;     // logTraces on
  parsed?: CommandResponse;
  error?: AttemptError;
  wire_capture_error?: string;      // wire capture itself threw; invocation still succeeds
  llm_ms?: number;                  // wall-clock for this physical call
};

type Round = {
  attempts: Attempt[];              // length >= 1 invariant
  execution?: Execution;
  llm_ms?: number;                  // wall-clock sum across attempts (kept for back-compat jq patterns)
  exec_ms?: number;
  followup_text?: string;
};
```

Removed from `Round`: `raw_response`, `parse_error`, `provider_error`, `parsed`. These all move inside `attempts[]`. Consumers that want the final parsed result read `round.attempts.at(-1)?.parsed`.

### Wire shapes

```ts
type WireRequest =
  | { kind: "http"; body: unknown }                         // ai-sdk: result.request.body, typed `unknown`
  | { kind: "subprocess"; argv: string[]; stdin: string }   // claude-code
  | { kind: "test" };

type WireResponse =
  | { kind: "http"; body: unknown; usage?: unknown; finishReason?: string }
  | { kind: "subprocess"; stdout: string; stderr?: string; exit_code: number }
  | { kind: "test" };
```

AI SDK types `request.body` and `response.body` as `unknown` (both optional). Capture code must tolerate undefined/non-string shapes and route to `wire_capture_error` when absent.

**`request_wire.body` is the SDK-added delta, not the full wire body.** `system` and `messages` are stripped before capture — they duplicate `attempt.request`. What remains is the SDK-translated fields: `model`, `max_tokens`, `tools`, `tool_choice`, `response_format`, etc.

```jsonc
// attempt.request (PromptInput — what wrap built)
{
  "system": "You are wrap...\n\nSchema: {...}",
  "messages": [ ...few-shots + context... ]
}

// attempt.request_wire.body (SDK-added fields only; system + messages stripped)
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 8192,
  "tool_choice": {"type":"tool","name":"response"},
  "tools": [{"name":"response","input_schema":{...}}]
}
```

Trade-off: `cache_control` markers live on the SDK's `system[]` blocks — stripping `system` drops them. Accepted; cache debugging can fall back to `response_wire.usage.cache_read_input_tokens` signal.

Each provider exposes a `buildWireRequest(raw): WireRequest | undefined` helper in its own file — providers know their own wire shape:

```ts
// src/llm/providers/ai-sdk.ts
function buildWireRequest(raw: unknown): WireRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { system: _s, messages: _m, ...rest } = raw as Record<string, unknown>;
  return { kind: "http", body: rest };
}
```

Response bodies are not stripped — `response_wire.body` is typically the tool-call result and doesn't duplicate anything in `attempt.raw_response` (raw_response is the text the SDK extracted; wire body is the full response envelope with `usage`, `stop_reason`, etc.).

Headers are **never** logged. Subprocess env dict is **never** logged. API keys stay redacted via the existing `redactProvider` path at the LogEntry level. Additionally: before serialization, scan `request_wire.body` / subprocess `stdin` for the resolved `apiKey` substring and replace with `...XXXX` (defensive — a future provider could serialize the key into the body).

### Invocation-level

`LogEntry` shape unchanged. `attached_input.preview` keeps its 1000-char cap — the full piped-input bytes appear inside `attempts[0].request.messages` when wrap embeds them in the prompt. Invocation-level preview stays a convenience field.

Memory-init LLM calls (separate, outside the round loop) are **not** captured. Out of scope for v1.

## Capture mechanics

### AI SDK providers (anthropic / openai-compat)

Uses `generateText` result fields (no custom `fetch`). Each provider file owns a `buildWireRequest(raw)` helper that strips `system` + `messages` and returns the SDK delta. See the plumbing section above for emit shape.

### Claude-code provider (CLI subprocess)

Emits `{ kind: "subprocess", argv, stdin: flattened }` for request and `{ kind: "subprocess", stdout, exit_code, stderr? }` for response.

**Caveat — `src/llm/utils.ts::spawnAndRead` currently throws on non-zero exit and returns only `stdout`.** Capturing `exit_code` (and optionally `stderr` for failed runs) requires widening `spawnAndRead` to return `{ stdout, stderr, exit_code }` and moving the non-zero-exit throw into the caller. Part of this spec's scope.

Env vars not captured.

### Test provider

Emits `{ kind: "test" }` stubs for both request and response so log shape is uniform and tests can assert against presence.

### Capture failures

Any throw inside the provider's wire-building code is caught. The `llm-wire` event still fires, with `wire: { wire_capture_error: "<message>" }`. `runRound` persists `wire_capture_error` on the attempt; `request_wire` / `response_wire` stay omitted. Logging invariant: a broken log never crashes an invocation.

## Plumbing — how `logTraces` reaches providers

Wire capture rides the existing notification bus (`src/core/notify.ts`), the same typed pub/sub that already carries `chrome` / `verbose` / `step-output` events.

**Why the bus, not a callback:** `PromptInput` stays a pure data shape, providers don't import logging types, and the pattern matches the house convention for cross-cutting observability.

### New notification kind

```ts
// src/core/notify.ts — add to the Notification union
| { kind: "llm-wire"; wire: WireCapture };

type WireCapture = {
  request_wire?: WireRequest;
  response_wire?: WireResponse;
  raw_response?: string;
  wire_capture_error?: string;
};
```

`writeNotificationToStderr` adds a no-op branch for `llm-wire` (same pattern as `step-output`, which is listener-only).

### Provider side

Every provider emits one `llm-wire` event per physical call, after the SDK / subprocess returns, before `runRound` parses. Emitting is unconditional — the bus fallback is a no-op with no subscribers, so memory-init emissions go nowhere.

```ts
// src/llm/providers/ai-sdk.ts (schema path)
const result = await generateText({...});
notifications.emit({
  kind: "llm-wire",
  wire: {
    request_wire: buildWireRequest(result.request.body),
    response_wire: {
      kind: "http",
      body: result.response.body,
      usage: result.usage,
      finishReason: result.finishReason,
    },
    raw_response: JSON.stringify(result.output),
  },
});
```

Any thrown error inside `buildWireRequest` / field access is caught and surfaces as `wire_capture_error` on the emitted event (logging invariant: never crash the invocation).

### runRound side

Per attempt:

```ts
let captured: WireCapture | undefined;
const unsub = subscribe((n) => { if (n.kind === "llm-wire") captured = n.wire; });
try {
  const parsed = await runCommandPrompt(provider, input);
  // build Attempt with captured + parsed
} finally {
  unsub();
}
```

### `logTraces` gating

The provider always emits. `runRound` reads the resolved `logTraces` flag and decides what to persist on the Attempt:

- `logTraces === false`: `attempt.request` omitted, `attempt.request_wire` omitted, `attempt.response_wire` omitted. `attempt.raw_response` follows its existing rule (always on parse failure, never on success).
- `logTraces === true`: all four populated when available.

Providers read no config. Memory-init emits too, but nothing subscribes, so events are dropped on the floor.

## Round loop changes (`src/core/round.ts`)

Current flow: `callWithRetry` wraps `runCommandPrompt` with a single json-retry. `runRound` calls `callWithRetry` twice under the scratchpad-retry branch, so in the worst case four physical LLM calls execute in one round, none visible individually.

Refactor: `callWithRetry` is deleted. `runRound` owns the retry ladder directly and calls `runCommandPrompt` at each step, appending one `Attempt` before deciding whether to retry:

1. Initial call.
2. If parse failed → json-retry (append failed text + `jsonRetryInstruction`).
3. If parsed high-risk command with null scratchpad → scratchpad-retry.
4. If 3 failed to parse → json-retry of scratchpad attempt.

Any branch (success, parse-retry, scratchpad-retry, provider error, empty response) appends its attempt first, then the loop decides. Reuse the base `PromptInput` built once via `buildPromptInput`; only suffix new turns per retry — don't rebuild the scaffold.

Each attempt gets its own `llm_ms` (wall-clock around the single `runPrompt` call). `round.llm_ms` stays as the sum for back-compat with existing jq queries.

## `--log` subcommand

No changes. Detailed entries render fully (`jq -C` / `JSON.stringify`). Users who don't want the noise pipe through `jq 'del(.rounds[].attempts[].request, .rounds[].attempts[].request_wire, .rounds[].attempts[].response_wire)'`.

## Size

No cap. Opt-in means the user accepts the bloat.

## Migration / breakage

Known in-tree readers of the removed fields (all must update):

- `src/core/runner.ts` — reads `round.parsed`.
- `src/core/round.ts` — writes `round.parsed` / `round.provider_error` / `round.parse_error`.
- `src/session/reducer.ts` — comment references `round.parsed.content` (stale doc after change).
- Tests: `tests/session.test.ts`, `tests/round.test.ts`, `tests/logging.test.ts` — every assertion against the old round-level fields.
- `vault/logging.md` — round shape section + `## What gets logged`. Must be updated in the same change.
- `vault/README.md` glossary — add `Attempt` term alongside `Round` and `Round retry`.

Not breaking (false alarm during review): `eval/bridge.ts` uses the literal string `"provider_error"` as a DSPy-level error category, not a reference to the log field. No change needed.

- Log files are append-only; no rewrite. Mixed-shape logs exist after upgrade — readers must tolerate both.
- `LogEntry.version` not bumped — `version` tracks wrap package version, which bumps on release. Shape change is visible through presence/absence of fields.

## Module map

- `src/config/settings.ts` — add `logTraces` entry.
- `src/config/config.schema.json` — add `logTraces: { type: "boolean" }`.
- `src/core/notify.ts` — add `llm-wire` notification kind + no-op stderr fallback.
- `src/logging/entry.ts` — redefine `Round`, add `Attempt` + `AttemptError` + wire types. Add body-redaction helper (apiKey substring scrub).
- `src/llm/utils.ts` — widen `spawnAndRead` to return `{ stdout, stderr, exit_code }`; move non-zero-exit throw to caller.
- `src/llm/providers/ai-sdk.ts` — emit `llm-wire` after each `generateText`; add `buildWireRequest` helper that strips `system` + `messages` from the SDK's request body.
- `src/llm/providers/claude-code.ts` — emit `llm-wire` after each subprocess call; re-throw on non-zero-exit.
- `src/llm/providers/test.ts` — emit `llm-wire` with `{ kind: "test" }` stubs.
- `src/core/round.ts` — delete `callWithRetry`, inline the four-step retry ladder into `runRound`; subscribe to `llm-wire` per attempt; build `Attempt` from captured wire + parsed/error; per-attempt `llm_ms` timing.
- `src/session/session.ts` — read `logTraces` from resolved config; thread into round runner.
- `vault/logging.md` — update round-shape section.
- `vault/README.md` — add `Attempt` to glossary.

## Test plan (TDD)

Each bullet = one failing test first.

### Config
- `--log-traces` flag sets `config.logTraces = true`.
- `WRAP_LOG_TRACES=1` sets it.
- Config file `{"logTraces":true}` sets it.
- Default is `false`.

### Shape — always-on
- Successful round: `attempts.length === 1`, `attempts[0].parsed` set, no `raw_response`, no `request`, no `request_wire`.
- Parse-failure round: `attempts.length === 2`, `attempts[0].raw_response` + `error.kind === "parse"`, `attempts[1].parsed` set.
- Provider error: `attempts[0].error.kind === "provider"`, no `parsed`.
- Empty response: `attempts[0].parsed` present (empty content), `attempts[0].error.kind === "empty"`.
- Scratchpad retry (high-risk + null scratchpad): `attempts.length === 2`, both have `parsed`.

### Shape — logTraces on
- Successful round: `attempts[0]` has `request`, `request_wire.kind === "http"`, `response_wire.usage` present, `raw_response` set.
- `request.messages` matches what was sent (snapshot or structural assertion).
- `request_wire.body` is a non-empty string.
- Claude-code provider: `request_wire.kind === "subprocess"`, `argv[0]` ends with `claude`, `stdin` non-empty.
- Test provider: `request_wire.kind === "test"` / `response_wire.kind === "test"`.

### Capture failure
- If ai-sdk's `result.request.body` is missing/unexpected, attempt gets `wire_capture_error`, invocation still succeeds, log still written.
- openai-compat providers: `result.response.body` shape is not guaranteed to contain `usage` across all OpenAI-compatible endpoints. Capture must tolerate absence.

### Memory-init
- Memory-init runs without `onCapture` callback → no capture regardless of `logTraces`.

### Redaction
- `LogEntry.provider.apiKey` still `...XXXX`.
- `request_wire` HTTP body: assert captured body does not contain the raw apiKey string. Test with a provider whose `apiKey` is a known sentinel, then assert `JSON.stringify(attempt.request_wire.body).includes(sentinel) === false`.

### --log subcommand
- `w --log` on an entry with `attempts[]` renders without crashing. No assertion on format.

## Decisions

- **attempts[] always present, even length 1.** One canonical shape. Non-detailed mode keeps attempts sparse.
- **Notification-bus plumbing.** `src/core/notify.ts` gets an `llm-wire` kind. `PromptInput` stays pure data; providers emit; `runRound` subscribes per attempt. Matches the house pattern already used for chrome/verbose.
- **Wire body stripped of `system` + `messages`.** `request_wire.body` carries only SDK-added deltas (model, max_tokens, tools, tool_choice, etc.). Per-provider `buildWireRequest` helper does the strip. Lose `cache_control` placement; cache debugging falls back to `response_wire.usage.cache_read_input_tokens`.
- **Structured `AttemptError` with `kind`.** Categorical (`parse` / `provider` / `empty`) beats free-text matching for consumers.
- **Per-attempt `llm_ms` + round-level sum.** Cheap to add (one `performance.now()` per call); useful for retry-cost analysis. Round-level sum kept for back-compat jq patterns.
- **No few-shot dedup across rounds.** Raw/faithful logs beat compactness; each round's prompt is what was sent, verbatim.
- **No HTTP headers.** Simpler than maintaining a redaction allowlist. Body carries enough for debugging prompt/response content.
- **No env dict for subprocess.** Same rationale.
- **No size cap.** Opt-in; user owns the bloat.
- **No log rotation.** Pre-existing concern. Not this spec's problem.
- **No append-atomicity fix.** Concurrent `w --log-traces` can corrupt a line; existing "corrupt lines skipped with stderr warning" path handles it.
- **Memory-init excluded.** Feature targets debugging the command/answer prompt. Memory-init is a separate call with its own lifecycle. Providers emit `llm-wire` unconditionally; memory-init emissions go to a bus with no subscribers and are dropped.
- **`request` + `request_wire` + `response_wire` only when `logTraces` on.** `raw_response` keeps today's always-on-failure behavior plus always-on-success when `logTraces`. Keeps non-detailed logs lean.
- **Name: `logTraces`.** "Trace" is the HTTP-capture convention (git, Rust, Java). Plural because multiple attempts per round, multiple rounds per invocation.
- **Breaking log shape.** `Round.parsed`/`raw_response`/`parse_error`/`provider_error` removed outright, not mirrored. User accepts one-time log-file rotation on upgrade.

## Unresolved

None.
