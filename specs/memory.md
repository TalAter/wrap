# Memory System — Implementation Spec

> **Date:** 2026-03-21
> **Status:** Ready for implementation

---

## Overview

Memory lets Wrap learn and remember facts about the user's environment. Facts are persisted to disk and included in every LLM request, so the LLM can generate better commands without redundant probes.

On first run, Wrap probes the system, sends raw output to the LLM to parse into concise facts, and saves them. Subsequent runs load memory from disk.

---

## Storage

- **File:** `~/.wrap/memory.json` (flat, alongside `config.jsonc`)
- **Path resolution:** Uses shared `getWrapHome()` from `src/core/home.ts`
- **Format:** JSON array of `MemoryEntry` objects

```ts
type MemoryEntry = { fact: string }
```

```json
[
  {"fact": "Runs macOS Darwin 25.3.0 on arm64 (Apple Silicon)"},
  {"fact": "Default shell is zsh, config at ~/.zshrc (symlinked to iCloud)"},
  {"fact": "Homebrew is the package manager"},
  {"fact": "Installed: git, docker, node, python3, bun, curl, jq"}
]
```

### Write semantics

- **Append-only.** New facts are appended. No deduplication or overwrite logic in v1.
- Contradictions (e.g., "pngquant not installed" then later "pngquant installed") are left for the LLM to resolve from context — it sees all facts and uses the most recent.
- Future: TTL per fact (e.g., "not installed" expires after 24h) to handle transient state.

### Corrupt file

If `memory.json` exists but is not valid JSON: **error and exit** (same pattern as config). User must fix or delete the file. Error prefix: `Memory error:`.

### Directory creation

Create `~/.wrap/` lazily — only when first writing `memory.json`, not eagerly in the main loop.

---

## Init Flow (`ensureMemory`)

Called from `main()` after `loadConfig()` and `initProvider()`.

```
ensureMemory(provider, wrapHome)
  │
  ├─ memory.json exists? ──→ load and return MemoryEntry[]
  │
  └─ first run:
       ├─ run local probe commands (no LLM)
       ├─ show spinner: "✨ Learning about your system..."
       ├─ send raw probe output to LLM via provider.runPrompt()
       ├─ parse response (one fact per line → MemoryEntry[])
       ├─ save to memory.json
       ├─ show summary: "🧠 Detected: macOS arm64, zsh, brew, git, docker..."
       └─ return MemoryEntry[]
```

If the LLM call fails → **error and exit**. If we can't reach the LLM for memory init, we can't reach it for the user's query either.

### Probe commands

Run locally, capture output, concatenate into a single string sent to the LLM:

| Probe | Command |
|-------|---------|
| OS | `uname -a` |
| Shell | `echo $SHELL` |
| Distro | `cat /etc/os-release 2>/dev/null \|\| echo "Not Linux"` |
| Shell config files | `ls -la ~/.*shrc ~/.*sh_profile ~/.*profile ~/.config/fish/config.fish 2>/dev/null` |
| Package manager | `which brew apt dnf pacman yum 2>/dev/null` |
| Core tools | `which git docker kubectl python3 node bun curl jq 2>/dev/null` |

~10 checks. Only tools where knowing availability materially changes what commands the LLM generates.

### Init LLM prompt

Uses `provider.runPrompt(systemPrompt, probeOutput)` — the generic prompt method, not `runCommandPrompt`. No JSON schema enforcement.

The system prompt instructs the LLM to:
- Parse raw probe results into concise, human-readable facts
- Return one fact per line (plain text, not JSON)
- Infer implicit facts (e.g., Darwin → macOS, arm64 → Apple Silicon)
- Include: OS + version + architecture, shell + config file location, package manager, list of installed tools from the probe
- Be concise — each fact should be a single short line

Response parsing: split by newlines, trim whitespace, filter empty lines, wrap each in `{fact: string}`.

### Init UX

All output goes to stderr (stdout is sacred).

1. Spinner with message: `✨ Learning about your system...`
2. After LLM responds, single summary line built from raw probe results (no LLM needed for this):
   `🧠 Detected OS, shell, git, docker, node, bun, curl, jq`
   - "OS, shell" are hardcoded — always detected, not worth parsing from probe output
   - Tool names extracted from `which` output: lines containing `/` are found tools, take the basename. Lines with "not found" are skipped.

---

## Runtime Memory Updates (Query Loop)

When the LLM returns `memory_updates` in a response during the query loop:

1. Append new entries to the in-memory array
2. Persist the full array to disk (`memory.json`)
3. Show `memory_updates_message` on stderr (e.g., `🧠 Noted: pngquant is not installed`)
4. The in-memory state is updated so the next LLM call in the same loop sees the new facts

No dedup. No overwrite. Just append and persist.

---

## Response Schema Change

Update `memory_updates` in the Zod response schema:

```ts
// Before
memory_updates: z.array(z.object({ key: z.string(), value: z.string() })).optional()

// After
memory_updates: z.array(z.object({ fact: z.string() })).optional()
```

`memory_updates_message` stays unchanged — it's the human-readable summary shown to the user.

Also update the embedded schema text in `src/prompt.optimized.ts` to match.

---

## LLM Integration

### Memory in regular queries

`runCommandPrompt(prompt, memory?)` — memory passed as optional parameter. This changes the `Provider` type in `src/llm/types.ts` and all provider implementations. The provider incorporates memory facts into the system prompt. Each provider decides formatting, but the intent is a section like:

```
## Known facts about the user's environment
- Runs macOS Darwin 25.3.0 on arm64 (Apple Silicon)
- Default shell is zsh, config at ~/.zshrc
- Homebrew is the package manager
- Installed: git, docker, node, python3, bun, curl, jq
```

### Provider lifecycle

Provider is created once in `main()` via `initProvider(config.provider)` and passed explicitly to `ensureMemory()` and `runQuery()`.

---

## Testing

Same pattern as config: **temp directories**. Each test gets its own `WRAP_HOME` pointing to an isolated tmp dir.

No interface abstraction for mocking — test real I/O against isolated filesystem.

Test cases:
- `loadMemory()` returns empty array when file doesn't exist
- `loadMemory()` returns parsed entries from valid file
- `loadMemory()` throws on corrupt JSON
- `saveMemory()` writes valid JSON
- `saveMemory()` appends to existing entries
- `ensureMemory()` loads existing memory (no LLM call)
- `ensureMemory()` runs init when no memory exists (probes + LLM call)
- `ensureMemory()` fails when LLM is unreachable
- Memory included in LLM context for queries
- `memory_updates` from LLM response get appended and persisted
- `memory_updates_message` shown on stderr
- End-to-end: clean install → first query gets memory-informed response

Feel free to add more tests as you develop. Use TDD!

---

## Module Structure

```
src/
  memory/
    memory.ts          loadMemory, saveMemory, ensureMemory, appendMemory
    init-prompt.ts     System prompt for init LLM call
    init-probes.ts     Probe commands and runner
```

---

## Out of Scope

- Memory TTL / expiry
- Vector search / selective memory retrieval
- Memory compaction / deduplication
- `wrap memory` subcommand
- Memory size limits / token budget warnings

---

## To Do

- [ ] Finalize probe commands — current list is provisional. Ideally run all with one or few shell commands
- [ ] End-to-end test: clean install → first query gets memory-informed response