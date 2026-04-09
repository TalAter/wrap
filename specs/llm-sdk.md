# LLM Integration

> Architecture for Wrap's LLM provider system: provider-agnostic interface, AI SDK integration, context assembly, and structured output handling.

> **Status:** Implemented

---

## Provider Interface

All LLM providers implement a single `runPrompt` method. Without a Zod schema it returns plain text (used by memory init). With a schema it returns a validated, typed object (used by the command/answer/probe flow).

`runCommandPrompt` is a convenience function in `src/llm/index.ts` that calls `provider.runPrompt(input, CommandResponseSchema)`. Schema awareness stays outside the provider — providers don't know about Wrap's command response format.

**PromptInput** separates system prompt from conversation messages:

- **System**: always exactly one string. Maps directly to the AI SDK's `generateText({ system, messages })`. CLI providers get a clean system string for `--system-prompt`.
- **Messages**: pure conversation turns (user/assistant). Used for few-shot examples, probe history, round retry turns, thread continuation.

**Why a single method with optional schema** (not overloads): TypeScript has issues with overloaded signatures on object literal implementations. A single function signature with optional schema keeps every provider implementable as a plain object.

---

## Provider Types

### AI SDK Provider (`src/llm/providers/ai-sdk.ts`)

`ai-sdk.ts` handles all AI SDK-supported backends; the provider registry (`src/llm/providers/registry.ts`) is the source of truth for which names map to which `kind` (`anthropic`, `openai-compat`, or `claude-code`). `openai-compat` covers `openai`, `ollama`, and any unknown user-defined OpenAI-compatible endpoint.

**Adding a new AI SDK provider** = one entry in `KNOWN_PROVIDERS` + `bun add @ai-sdk/<provider>` (only if a new SDK family, which also means a new `kind` + a branch in `initProvider`).

Static imports for all provider packages. Wrap is a run-once CLI — startup cost is negligible, and static imports keep `initProvider` synchronous.

**API key resolution** (in the same file):
- **Omitted** → `undefined` — AI SDK reads its default env var (e.g., `ANTHROPIC_API_KEY`). Zero config for users with standard env vars.
- **`"$MY_KEY"`** → reads `process.env["MY_KEY"]`. Clear config error if not set.
- **Literal string** → used as-is. Same security posture as any dotfile credential store.

### Claude Code Provider (`src/llm/providers/claude-code.ts`)

Spawns `claude` CLI as a subprocess. Flattens the multi-turn message array into a single string with role markers for the `-p` flag. Optionally passes JSON schema for structured output.

### Test Provider (`src/llm/providers/test.ts`)

Deterministic mock for testing. Reads from `WRAP_TEST_RESPONSE` env var. With schema → parses as JSON and validates. Without → returns as string. Selected by setting the env var, not by config — `resolveProvider` short-circuits to a `TEST_RESOLVED_PROVIDER` sentinel.

### Provider Dispatch (`src/llm/index.ts`)

`initProvider(resolved)` takes a `ResolvedProvider` and dispatches via the registry's `kind` to the matching factory. The `test` sentinel is special-cased.

---

## Context Assembly (`src/llm/context.ts`)

`assembleCommandPrompt(ctx)` builds a `PromptInput` from the query context. It delegates to two pure functions:

- **`formatContext()`** (`src/llm/format-context.ts`) — converts memory, tools, cwd, piped flag into a context string
- **`buildPrompt()`** (`src/llm/build-prompt.ts`) — assembles system message + messages array from config, context, and query

Ordering is designed for **cache efficiency** (static prefix first) and **contamination prevention** (few-shot separated from real context).

**System prompt** (static, cacheable):
- `instruction` + `schemaText` from `prompt.optimized.json`, plus fixed instructions from `prompt.constants.json`

**Messages** (in order):
1. **Few-shot examples** as user/assistant turn pairs (static, cacheable)
2. **Separator**: `"Now handle the following request."` — marks boundary between examples and real conversation. Prevents the LLM from treating thread history or context as more examples.
3. **Final user message** — memory facts (filtered by CWD prefix, sectioned by scope) + CWD + user prompt

**Why memory and CWD go in the final user message** (not the system prompt): They're dynamic per-request. Keeping them out of the system prompt makes the system + few-shot prefix fully static and cacheable.

Prompt data lives in two shared JSON files. **`src/prompt.constants.json`** contains static strings (section headers, separators, behavioral instructions) — committed to git, edited by hand. **`src/prompt.optimized.json`** contains optimizer output (instruction, demos, schema text, prompt hash) — written by `bun run optimize`. See `eval/specs/eval.md` for the optimization pipeline.

---

## Config

Config carries a `providers` map keyed by user-facing provider name plus a `defaultProvider`. Each entry stores its own `apiKey?`, `baseURL?`, and `model`. `--model` / `--provider` / `WRAP_MODEL` overrides which entry is used for a single run. Full shape, resolution rules, and error matrix: `specs/multi-provider-config.md`.

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

When `runCommandPrompt` throws a structured output error (invalid JSON, schema mismatch), round retry: retry once. The retry appends the failed output as an assistant turn + a stricter instruction as a user turn. Messages are cloned before retry to avoid mutating the caller's array (important inside a loop).

This logic lives in `src/core/query.ts` — it's provider-agnostic.

---

## Open Questions

1. **Schema text in system prompt**: For API providers with native structured output, embedding schema text is redundant but helps the LLM understand field semantics. Always included for now — can optimize later.
2. **Few-shot + structured output**: Few-shot example assistant turns contain raw JSON. Need to verify this works well with `Output.object()`. If it causes issues, fall back to embedding few-shot examples in system prompt.
3. **Separator message**: The "Now handle the following request." separator is a prompt engineering hypothesis. Should be validated via eval.
