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

One file handles all AI SDK-supported backends (Anthropic, OpenAI, future others). A `MODEL_FACTORIES` map routes `config.type` to the correct SDK factory.

**Adding a new AI SDK provider** = extend the config type union + add a `MODEL_FACTORIES` entry + `bun add @ai-sdk/<provider>`. No new files, no changes to `initProvider`.

Static imports for all provider packages. Wrap is a run-once CLI — startup cost is negligible, and static imports keep `initProvider` synchronous.

**API key resolution** (in the same file):
- **Omitted** → `undefined` — AI SDK reads its default env var (e.g., `ANTHROPIC_API_KEY`). Zero config for users with standard env vars.
- **`"$MY_KEY"`** → reads `process.env["MY_KEY"]`. Clear config error if not set.
- **Literal string** → used as-is. Same security posture as any dotfile credential store.

### Claude Code Provider (`src/llm/providers/claude-code.ts`)

Spawns `claude` CLI as a subprocess. Flattens the multi-turn message array into a single string with role markers for the `-p` flag. Optionally passes JSON schema for structured output.

### Test Provider (`src/llm/providers/test.ts`)

Deterministic mock for testing. Reads from `WRAP_TEST_RESPONSE` env var. With schema → parses as JSON and validates. Without → returns as string.

### Provider Dispatch (`src/llm/index.ts`)

`initProvider(config)` is a synchronous switch that routes config type to the correct provider factory.

---

## Context Assembly (`src/llm/context.ts`)

`assembleCommandPrompt(ctx)` builds a `PromptInput` from the query context. Ordering is designed for **cache efficiency** (static prefix first) and **contamination prevention** (few-shot separated from real context).

**System prompt** (static, cacheable):
- `SYSTEM_PROMPT` + `SCHEMA_TEXT` from `prompt.optimized.ts`

**Messages** (in order):
1. **Few-shot examples** as user/assistant turn pairs (static, cacheable)
2. **Separator**: `"Now handle the following request."` — marks boundary between examples and real conversation. Prevents the LLM from treating thread history or context as more examples.
3. **Thread history** turns (if continuing — not yet implemented)
4. **Final user message** — memory facts (filtered by CWD prefix, sectioned by scope) + CWD + user prompt

**Why memory and CWD go in the final user message** (not the system prompt): They're dynamic per-request. Keeping them out of the system prompt makes the system + few-shot prefix fully static and cacheable.

Updates to message structure must also be replicated in the eval pipeline.

---

## Config

One config shape for all AI SDK providers — `type` discriminant determines which SDK factory to use:

```jsonc
// Anthropic (minimal — reads ANTHROPIC_API_KEY from env)
{ "provider": { "type": "anthropic" } }

// OpenAI with explicit model and key
{ "provider": { "type": "openai", "model": "gpt-4o", "apiKey": "sk-..." } }

// Ollama via OpenAI-compatible endpoint
{ "provider": { "type": "openai", "model": "llama3", "baseURL": "http://localhost:11434/v1" } }
```

Fields: `type` (required), `model` (optional, defaults vary by type), `apiKey` (optional, see resolution above), `baseURL` (optional, for custom endpoints). Config schema in `src/config/config.schema.json` supports all provider types.

---

## Round Retry

When `runCommandPrompt` throws a structured output error (invalid JSON, schema mismatch), round retry: retry once. The retry appends the failed output as an assistant turn + a stricter instruction as a user turn. Messages are cloned before retry to avoid mutating the caller's array (important inside a loop).

This logic lives in `src/core/query.ts` — it's provider-agnostic.

---

## Open Questions

1. **Schema text in system prompt**: For API providers with native structured output, embedding schema text is redundant but helps the LLM understand field semantics. Always included for now — can optimize later.
2. **Few-shot + structured output**: Few-shot example assistant turns contain raw JSON. Need to verify this works well with `Output.object()`. If it causes issues, fall back to embedding few-shot examples in system prompt.
3. **Separator message**: The "Now handle the following request." separator is a prompt engineering hypothesis. Should be validated via eval.
