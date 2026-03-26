# Memory System

> **Status:** Implemented (2026-03-25)

---

## Overview

Memory lets Wrap learn and remember facts about the user's environment. Facts are persisted to disk and included in every LLM request, so the LLM can generate better commands without redundant probes.

Each fact has a **scope** — a directory it applies to. Facts scoped to `/` are global and always sent. Facts scoped to a specific directory are only sent when CWD is that directory or a subdirectory. This lets Wrap learn per-project knowledge — tooling, test commands, build systems — without polluting every request.

On first run, Wrap probes the system, sends raw output to the LLM to parse into concise facts, and saves them as global facts. Subsequent runs load memory from disk. Project-specific facts emerge organically during use — the LLM discovers project tooling (lockfiles, config files) and returns memory updates with the appropriate scope.

---

## Storage

- **File:** `~/.wrap/memory.json` (alongside `config.jsonc`, resolved via `getWrapHome()`)
- **Directory creation:** `~/.wrap/` is created lazily on first write.

### Format

Map of scope (resolved absolute path) → fact objects, validated with Zod on load:

```json
{
  "/": [
    {"fact": "Runs macOS Darwin 25.3.0 on arm64 (Apple Silicon)"},
    {"fact": "Default shell is zsh, config at ~/.zshrc"},
    {"fact": "Homebrew is the package manager"},
    {"fact": "Installed: git, docker, node, python3, bun, curl, jq"}
  ],
  "/Users/tal/monorepo": [
    {"fact": "Uses bun"},
    {"fact": "Run tests with `bun run test`"}
  ],
  "/Users/tal/monorepo/packages/api": [
    {"fact": "Uses postgres"},
    {"fact": "Has a Makefile"}
  ]
}
```

`Fact` is an object (not a plain string) to support future fields like `expires`.

On corrupt or invalid file, a single actionable error is shown using `prettyPath` for the file path.

### Write semantics

- **Append-only within each scope.** New facts are pushed to the end of the array for their scope.
- **Newer facts (higher index) take precedence** over older contradicting facts. The LLM is told this in the system prompt.
- **Keys sorted alphabetically on every write.** `/` comes first, then by path depth naturally. This order is preserved on read — no runtime sorting needed at prompt assembly time. More specific facts appear later in the prompt, closer to the user's request, leveraging the LLM's recency bias.
- **Non-existent scopes discarded.** Scopes that don't resolve to an existing directory (via `resolvePath`) are silently dropped.

---

## Path Conventions

Two utilities in `src/core/paths.ts`: `resolvePath` (canonical absolute path, null if non-existent) and `prettyPath` (substitutes `~` for homedir).

- **Storage and prompt injection:** always use resolved absolute paths.
- **User-facing chrome messages:** always use `prettyPath`.
- **CWD:** resolved once at startup in `main.ts`, passed through as context.

---

## Data Flow

| Boundary | Shape |
|----------|-------|
| On disk | `Memory` = `Record<FactScope, Fact[]>` — scope is the key |
| main → query | Full `Memory` map + resolved CWD string |
| query → context | `QueryContext.memory` (`Memory`, filtered in context.ts) |
| LLM response | `memory_updates`: `{fact: string, scope: string}[]` |
| context → prompt | Sectioned markdown text |

The full memory map flows from `main.ts` through `runQuery` to `assembleCommandPrompt`, where it's filtered by CWD. The LLM returns `{fact, scope}` pairs, which `appendFacts` resolves and persists, returning the updated map so the next LLM call in the same loop sees the new facts.

---

## Prompt Assembly

### Filtering

For each scope in stored order (alphabetical), include it if CWD is at or below that directory. **Prefix match uses trailing slashes** to avoid false positives with sibling directories (e.g., `/monorepo` must not match `/monorepo-tools`).

Global facts are always included because every CWD starts with `/`.

### Format

- `/` scope → `## System facts`
- All other scopes → `## Facts about {resolved_path}` (full absolute paths so the LLM can reference and return them)
- Sections only appear if they have facts after filtering. If no facts match at all, the entire block is omitted.

### Recency

The system prompt includes: *"When multiple memory facts contradict each other, the later (more recent) fact is more current and should take precedence."*

---

## Init Flow

Called from `main()` after `loadConfig()` and `initProvider()`:

```
ensureMemory(provider, wrapHome)
  │
  ├─ memory.json exists and has at least one scope key?
  │    ──→ load and return Memory
  │
  └─ first run (file missing or empty map):
       ├─ run local probe commands (no LLM)
       ├─ show "✨ Learning about your system..." on stderr
       ├─ send raw probe output to LLM (plain text, one fact per line)
       ├─ wrap result as { "/": facts }
       ├─ save to memory.json
       ├─ show summary: "🧠 Detected OS, shell, git, docker..."
       └─ return Memory
```

If the LLM call fails → error and exit. If we can't reach the LLM for memory init, we can't reach it for the user's query either.

Init always scopes facts to `/` (global). The init flow uses its own plain-text prompt and response parsing, not the Zod command response schema.

---

## Runtime Memory Updates

When the LLM returns `memory_updates` in a query response:

1. `appendFacts` resolves each scope via `resolvePath` (handles absolute paths, relative paths like `.`, and `~`). Non-existent paths are silently discarded. Facts are appended to the correct scope, keys are sorted, and the map is persisted.
2. The in-memory state is updated so the next LLM call in the same loop sees the new facts.
3. `memory_updates_message` is shown on stderr with a scope prefix for non-global facts: `🧠 (~/project) Noted: uses bun`. Global-only updates use the plain `🧠` prefix. When a batch contains multiple scopes, the deepest (most specific) resolved non-global scope is shown.

---

## LLM Response Schema

Each `memory_updates` entry carries a `scope` field — an absolute directory path (or `/` for global). Inline comments in the Zod schema guide the LLM's scoping decisions (these comments are extracted into `SCHEMA_TEXT` and read by the LLM on every request).

---

## Out of Scope

- Memory TTL / expiry (storage format supports adding fields to fact objects)
- Memory compaction / deduplication
- `wrap memory` subcommand (separate feature)
- Memory size limits / token budget warnings
- Auto-probing CWD on first visit (project-specific facts emerge organically from use)
- Memory editing / deletion UI
