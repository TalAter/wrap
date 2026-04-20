---
name: llm
description: Provider interface, taxonomy, prompt scaffold, structured output, round retry
Source: src/llm/
Last-synced: c54a1a5
---

# LLM

## Provider interface

Every provider implements `runPrompt(input, schema?)`.

- **No schema** → plain text. Used by memory init.
- **With a Zod schema** → validated, typed object. Used by the command/reply flow.

Schema-awareness stays outside providers; they don't know about Wrap's command-response format. `runCommandPrompt` is the thin wrapper that injects `CommandResponseSchema`.

`PromptInput` separates `system: string` from `messages: ConversationMessage[]`. CLI providers pass `system` via `--system-prompt`. `messages` are pure user/assistant turns: few-shot examples, separator, context, user query, round-retry turns, thread continuation.

## Provider taxonomy

| Name          | Allowed fields                                | `kind`          | Dispatches to                          |
|---------------|-----------------------------------------------|-----------------|----------------------------------------|
| `anthropic`   | `apiKey?`, `baseURL?`, `model`                | `anthropic`     | AI SDK anthropic factory               |
| `openai`      | `apiKey?`, `baseURL?`, `model`                | `openai-compat` | AI SDK openai factory                  |
| `ollama`      | `baseURL` *(required)*, `model`               | `openai-compat` | AI SDK openai factory (placeholder key)|
| `claude-code` | `model`                                       | `claude-code`   | `claude` CLI subprocess                |
| *any other*   | `baseURL`, `apiKey`, `model` (all required)   | `openai-compat` | AI SDK openai factory                  |

The registry at `src/llm/providers/registry.ts` is the single source of truth. `API_PROVIDERS` and `CLI_PROVIDERS` each carry runtime metadata (`kind`, optional `validate`, `modelOptional`) and wizard metadata (`displayName`, `apiKeyUrl`, recommended-model regex). `getRegistration(name)` falls through both maps. `kind` selects the SDK family.

Unknown provider names default to `openai-compat` so users can point Wrap at groq / together / fireworks without code changes. The user-facing name **is** the discriminant — there is no `type` field.

## Prompt scaffold

The per-session `PromptScaffold` is built once at session start, not per round:

```
{ system, prefixMessages, initialUserText }
```

- `system` — concatenated instruction blocks. Static, cacheable.
- `prefixMessages` — few-shot turn pairs + a separator user turn. Prepended verbatim to every round.
- `initialUserText` — context string + user query. Pushed to the transcript as the first user turn.

The runner combines these with the evolving transcript each round via `buildPromptInput`. The scaffold itself is immutable.

### Composition

System prompt: `instruction` + `memoryRecencyInstruction` + `toolsScopeInstruction` + `voiceInstructions` + (if stdin was piped) `attachedInputInstruction` + (if a schema is attached) `schemaInstruction` + `schemaText`. All joined with blank lines.

Message ordering (cache-friendly):

1. Few-shot user/assistant pairs — static, cacheable across runs.
2. Separator ("Now handle the following request.") as a final user turn in `prefixMessages`. Marks the boundary so the LLM does not treat real conversation as more examples.
3. Initial user turn: context string + section-request header + query.
4. Subsequent round turns, appended by the loop.

### Source files

- `src/prompt.constants.json` — static strings (section headers, separators, behavioral instructions). Committed and hand-edited.
- `src/prompt.optimized.json` — DSPy optimizer output (instruction, demos, schema text, prompt hash). Regenerated via `bun run optimize`. See `eval/specs/eval.md`.

**Before editing prompt text, read `.claude/skills/editing-prompts.md`.** The prompt has a Python source of truth (for the DSPy optimizer) and a TS runtime mirror — editing the wrong one silently breaks the optimizer.

## Context building

Delegated to pure functions:

- `formatContext()` in `src/llm/format-context.ts` — turns memory (filtered by cwd prefix, sectioned by scope), tools, cwd files, cwd, the piped-stdout flag, and the attached-input preview (see [[piped-input]]) into a single context string.
- `buildPromptScaffold()` in `src/llm/build-prompt.ts` — assembles `system` + `prefixMessages` + `initialUserText` from prompt config, context string, and query.

Inputs come from [[memory]] and [[discovery]].

## Structured output

The AI SDK path calls `generateText` with `Output.object({ schema })`. Two gotchas:

### OpenAI strict schema

OpenAI's strict mode requires every property to appear in `required`. Wrap's Zod schema uses `.nullable().optional()` for optional fields, which generates `anyOf: [type, null]` — but the keys still are not listed in `required`. `toOpenAIStrictSchema` walks the JSON schema tree (`properties`, `items`, `anyOf` / `oneOf` / `allOf`) and injects every property key into `required`. Applied to `openai-compat` only; the Anthropic factory passes the Zod schema straight through.

### Local-endpoint placeholder key

`@ai-sdk/openai` demands an API key even when `baseURL` points at a local model server (Ollama, LM Studio). When `baseURL` is set and no key is configured, Wrap injects the literal `"nokey"` so local models work without a dummy env var.

## Provider implementations

- **AI SDK provider** (`src/llm/providers/ai-sdk.ts`) — dispatches on `kind` to `createAnthropic` or `createOpenAI`, then `generateText` with `Output.object({ schema })`.
- **Claude Code provider** (`src/llm/providers/claude-code.ts`) — spawns the `claude` CLI. Passes `--system-prompt` directly; flattens the messages array into a single `-p` string (`User: ...\n\nAssistant: ...`) because the CLI has no multi-turn input format. With a schema, passes `--json-schema` and strips code fences from the response. Runs in `tmpdir()` to avoid leaking the user's cwd; `--no-session-persistence` prevents disk state.
- **Test provider** (`src/llm/providers/test.ts`) — deterministic mock selected by env presence, not config. `WRAP_TEST_RESPONSE` serves one canned response for every call; `WRAP_TEST_RESPONSES` is a JSON array consumed in order. Responses starting with `ERROR:` throw. With a schema, responses are JSON-parsed and validated. Config is not consulted at all — tests do not need a providers block.
- **Dispatch** (`src/llm/index.ts`) — `initProvider(resolved)` takes a `ResolvedProvider`, special-cases the `test` sentinel, and otherwise switches on `getRegistration(name).kind`.

## Round retry

A structured-output error (invalid JSON, schema mismatch, `NoObjectGeneratedError`) retries the round **once**. The retry appends the failed raw text as an assistant turn plus `jsonRetryInstruction` as a user turn, so the model can self-correct.

Retry messages are built fresh — the caller's `input.messages` is never mutated, because rounds reuse it.

## Decisions

- **Single `runPrompt`, optional schema.** TypeScript overloads on object-literal implementations are painful; one signature keeps every provider a plain object.
- **Static imports for providers.** Run-once CLI; startup cost is negligible. Keeps `initProvider` synchronous and the dispatch table obvious.
- **Name is the discriminant; no `type` field.** Provider name maps to `kind` via the registry. Users type `anthropic`, not `{ type, name }`.
- **Unknown providers require `apiKey`.** Without one the call would silently send a placeholder against a billed endpoint.
- **Memory and cwd in the user turn, not `system`.** Dynamic per-request; keeping them out of `system` lets the prefix be cached.
- **Scaffold, not string.** Cache-friendly ordering, deterministic tests, few-shot examples as real turns instead of inline text.
- **Retry once, not loop.** Structured-output failures the model can self-correct happen once. A loop hides real breakage (missing fields, wrong types) behind cost.

## Extending

- **New built-in provider** — one entry in `API_PROVIDERS` or `CLI_PROVIDERS`.
- **New SDK family** — new `kind`, new branch in `initProvider`, new factory file.
