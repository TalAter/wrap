# LLM Integration

> Architecture for Wrap's LLM provider system: provider-agnostic interface, AI SDK integration, prompt scaffold assembly, and structured output handling.

> **Status:** Implemented

---

## Provider Interface

All providers implement a single `runPrompt(input, schema?)` method. Without a Zod schema → plain text (used by memory init). With a schema → validated, typed object (used by the command/answer/probe flow).

`runCommandPrompt` (`src/llm/index.ts`) is a thin convenience that calls `provider.runPrompt(input, CommandResponseSchema)`. Schema-awareness stays outside the provider: providers don't know about Wrap's command response format.

**`PromptInput`** separates `system: string` from `messages: ConversationMessage[]`:

- **System**: exactly one string. Maps directly to the AI SDK's `generateText({ system, messages })`. CLI providers (claude-code) pass it via `--system-prompt`.
- **Messages**: pure user/assistant turns. Used for few-shot examples, separator, context, user query, round retry turns, thread continuation.

**Why a single method with optional schema** (not overloaded signatures): TypeScript struggles with overloads on object-literal implementations. One signature keeps every provider implementable as a plain object.

---

## Provider Types

Provider **taxonomy** lives in `src/llm/providers/registry.ts` — the single source of truth. Each known name maps to a `kind`:

- `anthropic` → `@ai-sdk/anthropic`
- `openai-compat` → `@ai-sdk/openai` (covers `openai`, `ollama`, and any unknown user-defined OpenAI-compatible endpoint)
- `claude-code` → `claude` CLI subprocess

Unknown provider names default to `openai-compat` so users can point Wrap at groq/together/fireworks/etc. without code changes (they must still supply `baseURL`, `apiKey`, `model` — enforced in `validateProviderEntry`).

**Adding a new built-in provider** = one entry in `KNOWN_PROVIDERS`. Adding a brand-new SDK family = new `kind` + new branch in `initProvider` + new factory file.

Static imports for all provider packages. Wrap is a run-once CLI — startup cost is negligible, and static imports keep `initProvider` synchronous.

### AI SDK Provider (`src/llm/providers/ai-sdk.ts`)

Dispatches on `kind` to `createAnthropic` or `createOpenAI`, then calls `generateText` with `Output.object({ schema })` for structured output.

**OpenAI strict-schema gotcha.** OpenAI's strict mode requires every property to appear in `required`. Wrap's Zod schema uses `.nullable().optional()` for optional fields, which generates `anyOf: [type, null]` — but the fields still aren't added to `required`. `toOpenAIStrictSchema` walks the JSON schema tree (`properties`, `items`, `anyOf`/`oneOf`/`allOf`) and injects every property key into `required`. Applied to `openai-compat` only; the Anthropic factory passes the Zod schema straight through.

**Local endpoint placeholder key.** `@ai-sdk/openai` demands an API key even when `baseURL` points at a local model server (Ollama, LM Studio). When `baseURL` is set and no key is configured, Wrap injects the literal `"nokey"` so local models work without the user setting a dummy env var.

**API key resolution** (`resolveApiKey`):
- **Omitted** → `undefined`; the SDK falls back to its default env var (e.g. `ANTHROPIC_API_KEY`). Zero config for users with standard env vars.
- **`"$MY_KEY"`** → reads `process.env.MY_KEY`. Clear `Config error:` if unset.
- **Literal string** → used as-is. Same posture as any dotfile credential store.

### Claude Code Provider (`src/llm/providers/claude-code.ts`)

Spawns `claude` CLI as a subprocess. Passes `--system-prompt` directly and **flattens** the messages array into a single `-p` string (`User: ...\n\nAssistant: ...`) because the CLI has no multi-turn input format. With a schema, passes `--json-schema` and strips code fences from the response before parsing.

Runs in `tmpdir()` to avoid leaking the user's cwd into Claude Code's own session discovery. `--no-session-persistence` prevents it from creating a session on disk. The `--bare` flag would skip MCP/config discovery (~10x faster) but also skips credential loading, so it's not usable until Claude Code fixes that.

### Test Provider (`src/llm/providers/test.ts`)

Deterministic mock driven by env vars:
- `WRAP_TEST_RESPONSE` → single canned response reused for every call.
- `WRAP_TEST_RESPONSES` → JSON array, one per call in order (throws if exhausted).
- Falls back to echoing the last user message if neither is set.
- A response starting with `ERROR:` throws. With a schema, the response is JSON-parsed and validated.

Selected by env presence, not by config — `resolveProvider` short-circuits to the `TEST_RESOLVED_PROVIDER` sentinel.

### Provider Dispatch (`src/llm/index.ts`)

`initProvider(resolved)` takes a `ResolvedProvider`, special-cases the `test` sentinel, and otherwise switches on `getRegistration(name).kind` to pick a factory.

---

## Prompt Scaffold Assembly (`src/llm/context.ts`)

The per-session **prompt scaffold** is built **once** at session start, not per round. `assemblePromptScaffold(ctx)` returns a `PromptScaffold`:

```
{ system, prefixMessages, initialUserText }
```

- **`system`**: concatenated instruction blocks (static, cacheable).
- **`prefixMessages`**: few-shot example turn pairs + separator, prepended verbatim to every round's messages array.
- **`initialUserText`**: the context string + user query, pushed to the transcript as the first user turn.

The runner combines these with the evolving transcript on each round via `buildPromptInput` to produce a fresh `PromptInput`. The scaffold itself is immutable.

It delegates to two pure functions:

- **`formatContext()`** (`src/llm/format-context.ts`) — memory (filtered by cwd prefix, sectioned by scope), tools, cwd files, cwd, piped-input flag → a single context string.
- **`buildPromptScaffold()`** (`src/llm/build-prompt.ts`) — assembles `system` + `prefixMessages` + `initialUserText` from prompt config, context string, and query.

### System prompt composition

`instruction` + `memoryRecencyInstruction` + `toolsScopeInstruction` + `voiceInstructions` + (optional) `pipedInputInstruction` + (if schema present) `schemaInstruction` + `schemaText`. All joined with blank lines.

### Message ordering (cache-friendly)

1. **Few-shot examples** as user/assistant pairs (static, cacheable across runs).
2. **Separator** (`fewShotSeparator`, e.g. "Now handle the following request.") as a final user turn in `prefixMessages`. Marks the boundary so the LLM doesn't treat real conversation as more examples.
3. **Initial user turn** (`initialUserText`): context string + `sectionUserRequest` + query. Pushed to the transcript by the session at startup.
4. **Subsequent round turns** appended by the loop.

**Why memory and cwd go in the user turn, not the system prompt.** They're dynamic per-request. Keeping them out of `system` makes the system-prompt + few-shot prefix fully static and eligible for provider-side prompt caching.

### Prompt data files

Two shared JSON files are the source of truth:

- **`src/prompt.constants.json`** — static strings (section headers, separators, behavioral instructions). Committed, hand-edited.
- **`src/prompt.optimized.json`** — optimizer output (instruction, demos, schema text, prompt hash). Written by `bun run optimize`. See `eval/specs/eval.md`.

**Before editing any prompt text, read `.claude/skills/editing-prompts.md`** — the prompt exists as a Python source of truth (for the DSPy optimizer) plus a TS runtime mirror, and editing the wrong one silently breaks the optimizer.

---

## Config

Config carries a `providers` map keyed by user-facing provider name plus a `defaultProvider`. Each entry stores `apiKey?`, `baseURL?`, `model`. `--model` / `--provider` / `WRAP_MODEL` overrides which entry is used for a single run. Full shape, resolution rules, and error matrix: `specs/multi-provider-config.md`.

```jsonc
{
  "providers": {
    "anthropic": { "apiKey": "$ANTHROPIC_API_KEY", "model": "claude-haiku-4-5" },
    "ollama":    { "baseURL": "http://localhost:11434/v1", "model": "llama3.2" }
  },
  "defaultProvider": "anthropic"
}
```

---

## Round Retry

When a round's LLM call throws a **structured-output error** (invalid JSON, schema mismatch, `NoObjectGeneratedError`), the round is retried **once**. The retry appends the failed raw text as an assistant turn plus `jsonRetryInstruction` as a user turn, so the model can self-correct.

Lives in `src/core/round.ts` as `callWithRetry` — provider-agnostic. Detection is in `isStructuredOutputError` (AI SDK's `NoObjectGeneratedError.isInstance` plus string-match fallbacks for providers that throw plain `Error`s). The failed text is extracted via `NoObjectGeneratedError.text` when available.

Messages are **not mutated** — the retry builds a fresh array. This matters because `callWithRetry` runs inside the round loop and the caller's `input.messages` is reused across rounds.

---

## Open Questions

1. **Schema text in system prompt.** For API providers with native structured output, the embedded schema text is redundant, but it helps the LLM understand field semantics. Always included for now.
2. **Few-shot + structured output.** Few-shot assistant turns contain raw JSON. Verify this plays well with `Output.object()`; fallback would be to move few-shot into the system prompt.
3. **Separator message.** The "Now handle the following request." turn is a prompt-engineering hypothesis. Validate via eval.
