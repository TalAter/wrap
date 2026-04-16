---
name: architecture
description: Invocation flow, core/session split, and cross-cutting design decisions
Source: src/main.ts, src/index.ts
Last-synced: c54a1a5
---

# Architecture

## Invocation flow

```
parseArgs(argv)                 strip modifier options
setConfig(resolveSettings(...)) seed from CLI + env + defaults
dispatch subcommand?            yes → run subcommand, exit
ensureConfig                    load config.jsonc or run wizard
setConfig(resolveSettings(...)) re-resolve with file layered in
resolveProvider                 config + override → ResolvedProvider
probeTools + loadWatchlist      which-check every tool
ensureMemory                    load or initialize memory
runSession                      rounds × LLM × dialog × execute
appendLogEntry                  JSONL at ~/.wrap/logs/wrap.jsonl
```

Subcommands short-circuit before `ensureConfig`. They see seeded config (CLI + env + defaults) but not file config or memory. See [[subcommands]].

## Core vs. session

`core/` runs one round: LLM call → parse → classify → execute. Pure, testable without Ink.

`session/` wraps `core/` with the dialog lifecycle, state reducer, and notification routing. Testable without the LLM.

Each half's tests pin its behavior without dragging in the other.

## Decisions

- **Sequential code, not pipeline/middleware.** Small fixed set of flows; pipeline composability doesn't pay for implicit ordering, shared mutable context, and indirection.
- **Ensure-pattern over resolve/execute split.** Flows continue after prerequisites — `ensureConfig()` returns and the next line runs. No second pass.
- **Global config store, no prop drilling.** Modules call `getConfig()`. Store holds `ResolvedConfig`; `setConfig` refuses partials. Wizard mutates mid-flight via `updateConfig(patch)`. See [[config]].
- **Prompt scaffold, not prompt string.** Cacheable prefix stays stable across rounds; few-shot examples are real turns. See [[llm]].
