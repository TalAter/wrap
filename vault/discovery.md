---
name: discovery
description: How Wrap learns its environment — init probes, tool probes, tool watchlist, CWD files, web reading
Source: src/discovery/, src/llm/format-context.ts
Last-synced: c54a1a5
---

# Discovery

Four mechanisms at different timescales:

| Mechanism | When | Persists |
|-----------|------|----------|
| Init probes | First run | Global memory facts |
| Tool probe + watchlist | Every invocation | Watchlist persists |
| CWD files | Every invocation | No (ephemeral context) |
| Non-final steps | On-demand during query | Scoped memory when appropriate |

## Init probes

First run: probe locally (OS, shell, distro, config files), send raw output to LLM to parse into concise facts, save as global (`/` scope) [[memory]]. Uses a plain-text prompt, not the command schema — it's a parsing task. Fail closed: LLM unreachable → error and exit.

Why LLM parsing: covers things that rarely change and benefit from semantic interpretation ("Darwin" → "macOS", "arm64" → "Apple Silicon").

## Tool probe

Runs before every query. Merges static `PROBED_TOOLS` list with the tool watchlist, runs one `which` call (~5ms), returns `{ available, unavailable }`.

Why every run: installed tools change (`brew install`), version managers switch paths per directory. `which` is always accurate.

Prompt format: `## Detected tools` (full paths, one per line) and `## Unavailable tools` (comma-separated). Either section omitted when empty.

Injection safety: tool names validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` before interpolation. Watchlist is a persistence point a compromised response could poison.

## Tool watchlist

`~/.wrap/tool-watchlist.json` — flat array of `{tool, added}` entries. Any LLM response may include `watchlist_additions`. The `added` date refreshes on re-nomination (for future pruning). Merged into the tool probe's `which` call on startup.

Why separate from memory: watchlist entries are tool names fed to `which` (always global), not scoped text shown to the LLM.

**Comprehensive nominations.** When returning `watchlist_additions`, the LLM nominates all well-known tools for the domain on the OS, not just the one it picks. Otherwise only the chosen tool appears in future `## Detected tools`, steering subsequent runs. Nominating the full domain gives balanced visibility.

## CWD files

Every request includes `## Files in CWD`. Depth-1 readdir sorted by mtime. Hard cap: 50 entries — oldest 20 + newest 30 when truncated, gap marker. No exclusions (`node_modules/` is a useful signal). Empty/unreadable → section omitted.

Why oldest + newest: pure newest misses stable project files; pure oldest misses active work.

## Web reading

URL-fetching reuses the non-final step loop — no new response type. The LLM probe-fetches URLs whose live content would improve the response, per a grounding rule in the system prompt: **if you can read the real thing, read it instead of guessing.**

HTML extraction tools (`textutil`, `lynx`, `w3m`) are in `PROBED_TOOLS`. LLM picks the pipeline based on detected tools. `maxProbeOutputChars` truncation keeps huge pages bounded. Dynamic (JS-rendered) sites won't return useful content via `curl` — known limitation. Fetching reuses the non-final step loop from [[multi-step]].

For `curl URL | sh` requests: fetch-step the script, analyze as a reply. Flag but don't chase nested downloads.

Step indicator: `🌐` for URL fetches, `🔍` otherwise.

## Decisions

- **Tool probe every run, not init.** Stale facts worse than 5ms cost.
- **Watchlist not "discovered tools".** It holds tools to repeatedly check, not confirmed-present tools. "`convert` not installed" saves a probe round too.
- **Step content is tactical, watchlist_additions is strategic.** Check what's needed now; nominate the full domain for future runs.
- **No CWD globbing in v1.** Parsing config files deferred — readdir signals suffice.
- **Grounding rule is prompt-level, not a mechanism.** Existing step loop handles everything.
