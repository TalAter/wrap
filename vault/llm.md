---
name: llm
description: Wrap's side of the LLM seam — prompt scaffold, add-time framing, scratchpad retry flow, test-provider env contract, JSONL record derivation
Source: src/llm/, src/core/round.ts
Last-synced: eb05626
---

# LLM

The conversation mechanics live in wrap-core: providers, registry, send/retry engine, conversation state, typed errors, abort semantics. Usage surface: `wrap-core-api/llm.md` (symlinked in this vault); internals: wrap-core's `vault/llm.md`. This note covers what stays wrap's: prompt content, framing, domain retries, env contracts, and how core's record becomes wrap's log.

Wrap holds one `Llm` handle per invocation (`initLlm` in `main.ts`): the session opens the query conversation on it, and memory init opens its own one-send conversation on the same handle — sharing, for the test provider, the playback cursor. Verbose/UI labels come from `llm.label` — the log's `provider` field still records wrap's own `ResolvedProvider` (test-selected invocations record `name: "test"` with no model; old entries carrying `model: "test"` are fine, readers shouldn't assume the field set is stable).

## Prompt scaffold

Built once per session, immutable: a system string, a prefix message list (few-shot pairs + separator turn), and the formatted context block (`src/llm/build-prompt.ts`, `context.ts`, `format-context.ts`). The scaffold is content, not mechanics — schema text, voice, section headers all wrap-owned.

Cache-friendly ordering: static few-shots first, then a separator user turn marking where examples end, then per-request context wrapped around the first user turn. Memory and CWD live in the user turn, not `system`, so the system prefix stays cacheable. Few-shots are real user/assistant turns, not inline prose; the separator prevents the model from treating real conversation as more examples.

### Source files

- `src/prompt.constants.json` — hand-edited static strings.
- `src/prompt.optimized.json` — DSPy/GEPA optimizer output (instruction, schema text; `fewShotExamples` always `[]`). Regenerated via `bun run optimize`. See `eval/specs/eval.md`.
- The JSON-parse-retry instruction is core-owned (`node_modules/wrap-core/src/llm/prompt-constants.json`); the optimizer reads it from there for its PROMPT_HASH manifest.

**Before editing prompt text, read `.claude/skills/editing-prompts.md`.** Python is the source of truth for the optimizer; TS mirrors it at runtime.

Context-block inputs come from [[memory]] (and the piped-stdout notice — see [[piped-input]]). Probe observations flow through the transcript as [[skills]]-emitted turns, not the context block.

## Add-time framing

Storage is bare; messages are framed when turns enter the conversation (`src/llm/framing.ts`). The transcript stays semantic turns — the same array as the durable `LogEntry.turns[]` — and a per-invocation `TurnFramer` turns each one into conversation messages as it is added: the first user turn gets the invocation's request framing (context block + section header), probe turns expand to an assistant/user pair, `final` turns become `<wrap-note>` user messages on continuation re-adds. A `-c` continuation re-adds prior turns through the same framer with fresh framing — no separate replay path.

Per-round directives are ordered **transient** adds (live temp-dir listing, last-round instruction): consumed by the send they precede, retained in core's entries marked consumed, never replayed.

The assistant echo is wrap content: `projectResponseForEcho`/`echoText` strip user-facing and already-actioned fields (see [[multi-step]]). Every echo site — the conversation's echo predicate, the framer's assistant case, the round's settled-echo add — goes through `echoText`, so the projection rule is structural.

## Scratchpad domain retry

Core's invisible parse retry lives inside `send`; the scratchpad retry is wrap domain logic in `src/core/round.ts` (see [[scratchpad]] for the why). Flow: send #1 returns a schema-valid but domain-rejected response (high-risk command, null scratchpad) → wrap's echo predicate (`formatCommandEcho`) returns `null`, so nothing replayable lands → round re-adds the transients plus the raw rejected JSON as a transient assistant/user echo pair → send #2. If the second response carries a scratchpad its echo lands via the predicate; if it is still null (accepted anyway — no-retry-storm) or send #2 fails to parse (wrap keeps response #1 for execution), the settled echo is added explicitly.

**The asymmetry is intended:** rejection flows through the predicate, acceptance through an explicit add. A domain-rejected response must never enter replay; the round decides what the settled echo is.

## Test-provider env contract

`WRAP_TEST_RESPONSE` (single, repeats) / `WRAP_TEST_RESPONSES` (JSON list, one entry per physical call) select core's canned-playback provider — wrap names the env vars and builds the config (`src/llm/llm-config.ts`); core reads no env vars. Selection short-circuits provider resolution entirely (`TEST_RESOLVED_PROVIDER`). Core's bare `LlmConfigError` messages get wrap's `Config error:` prefix at the surfacing site.

## Provider resolution

`resolve-provider.ts` (config → `ResolvedProvider`) and `parseModelOverride` stay in wrap until config ingestion lifts to core. The registry rules they consult (`isKnownProvider`, `validateProviderEntry`, `getRegistration`) are core's.

## JSONL record derivation

The on-disk schema predates the core flip and stays stable. `round.ts` derives each round's `AssistantTurn` from the conversation record after its sends settle: the round's send-produced entries flatten into one attempts list (up to four physical calls — two sends × core's in-send retry — merge into ONE assistant turn), `llm_ms` sums across them, and `toAttemptMeta` maps core `Attempt`s to wrap's `AttemptMeta`. Core wire fields flow into the trace sidecar intentionally unmapped except for naming: subprocess `exitCode` → `exit_code`. Trace gating (`logTraces`) is applied here, at record-build time — core always captures; wrap decides what persists. Wrap's `empty` error kind is a post-parse domain annotation, never derived from core. Aborted sends leave sealed null-message entries and no turn. See [[logging]].

## Decisions

- **Name as discriminant.** Users type provider names, not tagged objects (registry now core's, rule survives).
- **Memory and cwd in the user turn.** Keeps the system prefix cacheable.
- **Scaffold, not string.** Cache-friendly ordering, deterministic tests, few-shots as real turns.
- **Storage bare, framing per-invocation.** Continuation applies fresh context instead of replaying stale framing.
- **One echo function.** All assistant-echo text flows through `echoText`; no site serializes a raw response.
- **Scratchpad retry accepts still-null.** Retry-storming is worse than a rare log gap; the confirm dialog is the final safety layer.
