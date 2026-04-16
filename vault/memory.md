---
name: memory
description: Scoped facts — storage, filtering, prompt assembly, runtime updates
Source: src/memory/, src/llm/format-context.ts
Last-synced: c54a1a5
---

# Memory

Wrap learns facts about the user's environment, persists them, and injects them into every LLM request. Each fact has a **scope** — an absolute directory. `/` is global and always included. A directory scope is included only when CWD is at or below it. Prefix match uses trailing slashes on both sides to prevent `/monorepo` matching `/monorepo-tools`.

Why directory scope: natural unit for CLI work. Deterministic filtering with no classifier and no LLM judgment at read time.

## Storage

`~/.wrap/memory.json` — `Record<scope, Fact[]>`. `Fact` is `{fact: string}` (not a plain string — future fields like `expires` can be added without migration).

Write semantics:
- Append-only within a scope.
- Newer facts take precedence over older contradicting ones (system prompt tells LLM this — recency bias is the conflict resolution strategy).
- Keys sorted alphabetically on every write. `/` sorts first; deeper paths follow. Preserved on read — prompt assembly needs no runtime sort; more specific facts land closer to the user's request.
- Deduped on append (exact text match within batch and against persisted state).
- Non-existent scopes silently dropped. `resolvePath` returns null for paths not on disk — prevents LLM from polluting memory with hallucinated paths.

Corrupt file → actionable error using `prettyPath`. No auto-recovery.

## Prompt assembly

Iterate scopes in stored order. Include if CWD is at or below. Sections: `/` → `## System facts`, others → `## Facts about {absolute_path}` (full path so LLM can reference exact scope). Empty sections omitted.

System prompt instructs: "When multiple memory facts contradict, the later (more recent) one takes precedence."

## Runtime updates

LLM returns `memory_updates: {fact, scope}[]`. `appendFacts` resolves each scope, drops non-existent paths, dedupes, appends, sorts keys, persists. Updated map threaded into next round so it sees new facts immediately.

`memory_updates_message` shown on stderr with `🧠` prefix. When batch contains non-global scopes, the deepest resolved non-global scope is shown as a `prettyPath` prefix.

Schema coupling: `memory_updates` field comments are extracted into `SCHEMA_TEXT` and shipped to the LLM. Editing the schema edits the prompt.

## Invariant

- **Memory writes are immediate.** Persisted before invocation ends, even on failure.

## Decisions

- **Tool availability NOT stored.** Package managers and version-managed tools change over time and vary by directory. Probed fresh every run via `which`. See [[discovery]].
- **Full memory snapshot in logs.** See [[logging]].
- **Recency over explicit versioning.** Append-only + recency instruction is simpler than edit/delete semantics and handles contradictions naturally.
