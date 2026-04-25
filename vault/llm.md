---
name: llm
description: Provider interface, taxonomy, prompt scaffold, structured output, round retry
Source: src/llm/
Last-synced: 0a22f2a
---

# LLM

Wrap talks to many providers through one thin interface. Schema-awareness lives outside providers — they don't know about Wrap's command-response format. Memory init uses plain text; the command/reply flow uses Zod-validated structured output.

## Provider taxonomy

A registry maps each provider name to a `kind` that selects the SDK family. Names supported as first-class: `anthropic`, `openai`, `openrouter`, `groq`, `mistral`, `ollama`, `claude-code`. Unknown names default to OpenAI-compat so users can point Wrap at any compat endpoint without code changes — but they must supply an API key (silent placeholder against a billed endpoint is unacceptable).

OpenAI-compat is deliberately separate from OpenAI proper: the OpenAI Responses API rejects multi-turn shapes against non-OpenAI backends, so those speak Chat Completions instead.

The user-facing name **is** the discriminant — no `type` field. Users type `anthropic`, not a tagged object.

## Prompt scaffold

Built once per session, immutable: a system string, a prefix message list (few-shot pairs + separator turn), and the initial user turn (context + query). The runner appends evolving transcript turns each round.

Cache-friendly ordering: static few-shots first, then a separator user turn marking where examples end, then the per-request context and query. Memory and CWD live in the user turn, not `system`, so the system prefix stays cacheable.

Few-shots are real user/assistant turns, not inline prose. The separator prevents the model from treating real conversation as more examples.

### Source files

- `src/prompt.constants.json` — hand-edited static strings.
- `src/prompt.optimized.json` — DSPy optimizer output (instruction, demos, schema text). Regenerated via `bun run optimize`. See `eval/specs/eval.md`.

**Before editing prompt text, read `.claude/skills/editing-prompts.md`.** Python is the source of truth for the optimizer; TS mirrors it at runtime. Editing the wrong one silently breaks the optimizer.

Context inputs come from [[memory]] and [[discovery]]. Piped-stdout context lives in [[piped-input]].

## Structured output

Two gotchas worth knowing:

- **OpenAI strict schema requires every property in `required`.** Wrap's optional fields use `.nullable().optional()`, which produces `anyOf: [type, null]` but no `required` entry. A walker injects every key. Gated per-provider — non-strict providers fall back to JSON mode and Zod validates.
- **OpenAI-compat clients demand an API key even for local servers.** Wrap injects a literal placeholder so Ollama/LM Studio work without a dummy env var.

## Claude Code provider

Spawns the `claude` CLI. Has no multi-turn input format, so messages are flattened into one prompt. Runs in a tmpdir with session persistence off — avoids leaking the user's cwd or writing disk state.

## Test provider

Selected by env presence, not config. Tests inject canned responses; config is not consulted. Responses prefixed `ERROR:` throw.

## Round retry

A structured-output failure (invalid JSON, schema mismatch) retries the round **once**, appending the failed raw text plus a corrective instruction. Not a loop: looping hides real breakage (missing fields, wrong types) behind cost.

## Decisions

- **Single `runPrompt`, optional schema.** TypeScript overloads are painful; one signature keeps every provider a plain object.
- **Static imports for providers.** Run-once CLI; startup cost is negligible.
- **Name as discriminant.** Users type provider names, not tagged objects.
- **Unknown providers require `apiKey`.** No silent placeholders against billed endpoints.
- **Memory and cwd in the user turn.** Keeps the system prefix cacheable.
- **Scaffold, not string.** Cache-friendly ordering, deterministic tests, few-shots as real turns.
- **Retry once, not loop.** Self-correctable failures happen once; loops mask bugs.
