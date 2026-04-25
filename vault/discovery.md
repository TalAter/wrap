---
name: discovery
description: How Wrap learns its environment — init probes, tool probes, watchlist, CWD files, web reading
Source: src/discovery/, src/llm/format-context.ts
Last-synced: 0a22f2a
---

# Discovery

Four mechanisms at different timescales:

| Mechanism | When | Persists |
|-----------|------|----------|
| Init probes | First run | Global memory facts |
| Tool probe + watchlist | Every invocation | Watchlist persists |
| CWD files | Every invocation | No |
| Non-final steps | On-demand during query | Scoped memory when appropriate |

## Init probes

First run probes locally (OS, shell, distro, config files), sends raw output to the LLM to parse into concise facts, saves them as global [[memory]]. Plain-text prompt — it's a parsing task. Fail closed: LLM unreachable means error and exit.

Why LLM parsing: covers things that rarely change and benefit from semantic interpretation ("Darwin" → "macOS", "arm64" → "Apple Silicon").

## Tool probe + watchlist

Runs before every query. Merges a static probe list with the watchlist, runs one `which` call (~5ms), reports which are available and which aren't.

Why every run: installed tools change (`brew install`), version managers switch paths per directory. `which` is always accurate, and stale facts are worse than 5ms.

The watchlist is a persistence point a compromised response could poison, so tool names are validated before interpolation.

**Comprehensive nominations.** When the LLM proposes watchlist additions, it nominates all well-known tools in the domain on the OS, not just the one it picked. Otherwise only its choice appears in future detected-tools lists, steering subsequent runs. Domain-wide nomination gives balanced visibility.

Watchlist is separate from memory: it holds tool names fed to `which` (always global), not scoped text shown to the LLM. Unavailable tools are useful too — "`convert` not installed" saves a probe round.

## CWD files

Every request includes a depth-1 readdir of CWD, sorted by mtime, capped at 50 entries (oldest 20 + newest 30 when truncated). No exclusions — `node_modules/` is itself a useful signal. Pure newest misses stable project files; pure oldest misses active work.

## Web reading

URL fetching reuses the non-final step loop — no new response type. The system prompt carries a grounding rule: **if you can read the real thing, read it instead of guessing.** HTML extraction tools are in the probe list; the LLM picks the pipeline based on detected tools. Output is truncated to keep huge pages bounded. JS-rendered sites won't return useful content via `curl` — known limitation.

For `curl URL | sh` requests: fetch the script, analyze as a reply. Flag but don't chase nested downloads.

See [[multi-step]] for the step loop.

## Decisions

- **Tool probe every run, not init.** Stale facts worse than 5ms cost.
- **Watchlist holds tools-to-check, not confirmed-present tools.** Negative results are useful.
- **Step content is tactical, watchlist additions are strategic.** Run what's needed now; nominate the full domain for future runs.
- **No CWD globbing in v1.** Parsing config files deferred — readdir signals suffice.
- **Grounding rule is prompt-level, not a mechanism.** Existing step loop handles everything.
