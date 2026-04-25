---
name: memory
description: Scoped facts — storage, filtering, prompt assembly, runtime updates
Source: src/memory/, src/llm/format-context.ts
Last-synced: 0a22f2a
---

# Memory

Wrap learns facts about the user's environment, persists them, and injects relevant ones into every LLM request. Each fact has a **scope** — an absolute directory. `/` is global and always included. A directory scope is included only when CWD is at or below it. Prefix matches use trailing slashes on both sides so `/monorepo` doesn't match `/monorepo-tools`.

Why directory scope: natural unit for CLI work. Deterministic filtering, no classifier, no LLM judgment at read time.

## Storage

`~/.wrap/memory.json`, scope-keyed. Append-only within a scope, deduped on append. Keys sorted so more specific facts land closer to the user request in the prompt. Non-existent scopes are silently dropped — prevents the LLM from polluting memory with hallucinated paths. Corrupt file fails with an actionable error; no auto-recovery.

Wipe with `w --forget` (see [[forget]]).

## Conflict resolution

Newer facts win over older contradicting ones. The system prompt tells the LLM this explicitly. Append-only + recency is simpler than edit/delete semantics and handles contradictions naturally.

## Prompt assembly

Sections per included scope. `/` becomes "System facts"; directory scopes use the absolute path so the LLM can reference the exact scope. Empty sections omitted.

## Runtime updates

The LLM may return memory updates each round. Wrap resolves scopes, drops non-existent ones, dedupes, persists, and threads the updated map into the next round so it sees new facts immediately. A stderr message announces updates with a brain glyph; non-global batches show the deepest scope as a path prefix.

The schema field's comments are extracted and shipped to the LLM as schema text — editing the schema edits the prompt.

## Decisions

- **Tool availability is NOT stored.** Tools change over time and vary by directory. Probed fresh every run. See [[discovery]].
- **Memory writes are immediate.** Persisted before invocation ends, even on failure.
- **Recency over explicit versioning.** Append + recency instruction beats edit/delete semantics.
- **Full memory snapshot in logs.** See [[logging]].
