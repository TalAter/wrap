---
name: architecture
description: Invocation flow, core/session split, and cross-cutting design decisions
Source: src/main.ts, src/index.ts
Last-synced: 0a22f2a
---

# Architecture

## Invocation flow

Parse args → seed config → maybe dispatch subcommand → ensure config (wizard if needed) → re-resolve config with file → resolve provider → probe tools → load memory → run session → append log entry.

Subcommands short-circuit before config file load and memory; they see CLI/env/defaults only. See [[subcommands]].

## Core vs. session

`core/` runs one round: LLM call → parse → classify → execute. Pure, testable without Ink.

`session/` wraps `core/` with the dialog lifecycle, state reducer, and notification routing. Testable without the LLM.

Each half's tests pin its behavior without dragging in the other.

## Decisions

- **Sequential code, not pipeline/middleware.** Small fixed flow set; pipelines pay for implicit ordering and shared mutable context without a payoff.
- **Ensure-pattern.** Prerequisite functions return; the next line runs. No resolve/execute split.
- **Global config store.** Modules call `getConfig()`; no prop drilling. Wizard mutates mid-flight. See [[config]].
- **Prompt scaffold, not prompt string.** Cacheable prefix stable across rounds; few-shot examples are real turns. See [[llm]].
