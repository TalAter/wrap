---
name: discovery
description: How Wrap learns its environment — init probes, the discovery skill, non-final steps, web reading
Source: src/memory/memory-init-probes.ts, src/skills/discovery.ts, src/watchlist.ts
Last-synced: 8e2e5c7
---

# Discovery

Four mechanisms at different timescales:

| Mechanism | When | Persists |
|-----------|------|----------|
| Init probes | First run | Global memory facts |
| Discovery skill | Every invocation | Watchlist persists |
| Non-final steps | On-demand during query | Scoped memory when appropriate |
| Web reading | On-demand during query | No |

## Init probes

First run probes locally (OS, shell, distro, config files), sends raw output to the LLM to parse into concise facts, saves them as global [[memory]]. Plain-text prompt — it's a parsing task. Fail closed: LLM unreachable means error and exit.

Why LLM parsing: covers things that rarely change and benefit from semantic interpretation ("Darwin" → "macOS", "arm64" → "Apple Silicon").

## Discovery skill

Fires on every invocation via [[skills]]. Emits `pwd`, `ls` (mtime-sorted, capped at 50), and `which <PROBED_TOOLS ∪ watchlist>` as transcript turns BEFORE the user prompt. Replaces what `formatContext` used to emit as `## Detected tools` / `## Files in CWD` context-block sections — observations flow through the transcript now, knowledge (memory facts) stays in the context block.

### Watchlist

A persistent list of tool names checked every run by the discovery skill's `which` task. Holds tool names, not confirmed-present tools — negative results ("`convert` not installed") save a probe round.

The watchlist is a persistence point a compromised response could poison, so tool names are validated against an anchored regex before interpolation.

**Comprehensive nominations.** When the LLM proposes watchlist additions, it nominates all well-known tools in the domain on the OS, not just the one it picked. Otherwise only its choice appears in future `which` output, steering subsequent runs. Domain-wide nomination gives balanced visibility.

Watchlist is separate from memory: it holds tool names fed to `which` (always global), not scoped text shown to the LLM. Lives at `src/watchlist.ts` — outside `src/skills/` on purpose, so the tracker (persistence) and its consumer (discovery skill's `which` task) stay decoupled.

## Web reading

URL fetching reuses the non-final step loop — no new response type. The system prompt carries a grounding rule: **if you can read the real thing, read it instead of guessing.** HTML extraction tools (lynx, w3m, textutil) are in PROBED_TOOLS; the LLM picks the pipeline based on what `which` reports. Output is truncated to keep huge pages bounded. JS-rendered sites won't return useful content via `curl` — known limitation.

For `curl URL | sh` requests: fetch the script, analyze as a reply. Flag but don't chase nested downloads.

See [[multi-step]] for the step loop.

## Decisions

- **Discovery happens via a [[skills]] now.** Probes flow through the transcript as turns, not context-block sections — keeps `formatContext` focused on knowledge (memory facts) instead of observations.
- **Tool probe every run, not init.** Stale facts worse than 5ms cost.
- **Watchlist holds tools-to-check, not confirmed-present tools.** Negative results are useful.
- **Step content is tactical, watchlist additions are strategic.** Run what's needed now; nominate the full domain for future runs.
- **No CWD globbing in v1.** Parsing config files deferred — readdir signals suffice.
- **Grounding rule is prompt-level, not a mechanism.** Existing step loop handles everything.
