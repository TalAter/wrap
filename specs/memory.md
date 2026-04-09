# Memory System

> **Status:** Implemented. Part of the top-level flow in `specs/ARCHITECTURE.md`. Behavioral spec in `specs/SPEC.md` section 10. Canonical terms (Memory, Scope, Fact) defined in `specs/SPEC.md` §Glossary.

---

## Purpose

Wrap learns Facts about the user's environment, persists them, and injects them into every LLM request so the model can skip redundant probes and generate better commands.

Each Fact has a **Scope** — an absolute directory. `/` is global and always included. A directory Scope is included only when CWD is at or below it. This keeps per-project knowledge (tooling, test commands, build systems) out of unrelated requests.

### Why Scopes (not tags or a flat list)

Directory-as-scope is the natural unit for CLI work: the user's intent is almost always about "here and below". Prefix-matching on CWD gives free, deterministic filtering with no classifier and no LLM judgment call at read time.

### Why tool availability is NOT stored

Package managers, clipboard utils, and version-managed tools (nvm, fnm, pyenv) change over time and vary by directory. Storing them risks stale facts. Instead, they are probed fresh every run via `which` and injected as `## Detected tools` (see `specs/discovery.md`). Memory holds only stable facts (OS, shell, project conventions).

---

## Storage

- **File:** `~/.wrap/memory.json` (alongside `config.jsonc`, resolved via `getWrapHome()`)
- **Directory:** `~/.wrap/` created lazily on first write.
- **Schema:** `Record<scope, Fact[]>`, validated with Zod on load. `Fact` is an object `{fact: string}`, not a plain string, so future fields (e.g. `expires`) can be added without a migration.
- **Keys:** resolved absolute paths. `/` denotes global.
- **On corrupt/invalid file:** single actionable error using `prettyPath` — user is told to delete and rerun. No auto-recovery (silent data loss is worse than a clear failure).

Example:

```json
{
  "/": [{"fact": "Runs macOS Darwin 25.3.0 on arm64"}],
  "/Users/tal/monorepo": [{"fact": "Uses bun"}, {"fact": "Run tests with `bun run test`"}],
  "/Users/tal/monorepo/packages/api": [{"fact": "Uses postgres"}]
}
```

### Write semantics & invariants

- **Append-only within a Scope.** New Facts go to the end of the array.
- **Newer Facts take precedence** over older contradicting ones. The system prompt tells the LLM this explicitly — recency bias is the conflict resolution strategy.
- **Keys sorted alphabetically on every write.** `/` sorts first; deeper paths naturally follow. This order is preserved on read so prompt assembly needs no runtime sort, and more specific Facts land closer to the user's request (LLM recency bias again).
- **Deduped on append.** `appendFacts` skips a Fact whose exact text already exists in that Scope (within one batch and against persisted state).
- **Non-existent Scopes are silently dropped** on append. `resolvePath` returns null for paths that don't exist on disk; those updates are discarded. This prevents the LLM from polluting memory with hallucinated paths.

---

## Path Conventions

Two utilities in `src/core/paths.ts`:
- `resolvePath(path, cwd)` — canonical absolute path, or `null` if the path doesn't exist. Handles absolute paths, relative paths (`.`), and `~`.
- `prettyPath(path)` — substitutes `~` for homedir.

Rules:
- **Storage and prompt injection:** resolved absolute paths.
- **User-facing chrome:** `prettyPath`.
- **CWD:** resolved once at startup in `main.ts` and threaded through as context.

---

## Data Flow

| Boundary | Shape |
|----------|-------|
| On disk | `Memory = Record<FactScope, Fact[]>` |
| main → query | Full `Memory` + resolved CWD |
| query → context | `QueryContext.memory`, filtered by CWD in `formatContext` |
| LLM response | `memory_updates: {fact, scope}[]` |
| context → prompt | Sectioned markdown |

The full map flows from `main.ts` through `runQuery` to prompt assembly, where `formatContext` filters by CWD. The LLM returns `{fact, scope}` pairs; `appendFacts` resolves scopes, persists, and returns the updated map so the next round in the same loop sees the new Facts.

---

## Prompt Assembly

### Filtering

Iterate Scopes in stored (alphabetical) order. Include a Scope if CWD is at or below it. **Prefix match uses trailing slashes on both sides** — otherwise `/monorepo` would falsely match `/monorepo-tools`. Global (`/`) always passes because every CWD starts with `/`.

### Sections

- `/` → `## System facts`
- Other Scopes → `## Facts about {absolute_path}` (full absolute path so the LLM can reference and return the exact Scope)
- Empty sections are omitted. If nothing matches, the whole block disappears.
- Followed by `## Detected tools` (runtime `which` output) then CWD — see `specs/discovery.md`.

### Recency

System prompt: *"When multiple memory facts contradict each other, the later (more recent) fact is more current and should take precedence."*

---

## Init Flow

On first run (empty memory), Wrap probes the system (OS, shell, distro, config files), sends raw output to the LLM, parses the response into Facts, and saves them as global. Subsequent runs just load from disk. LLM failure → error and exit (Wrap cannot function without baseline facts).

Full probe set, LLM prompt, UX, and the `ensureMemory` flow diagram live in `specs/discovery.md`.

---

## Runtime Memory Updates

When the LLM returns `memory_updates`:

1. `appendFacts` resolves each Scope (absolute, relative, or `~`), drops non-existent paths, dedupes, appends, sorts keys, persists.
2. The returned in-memory map is threaded into the next round so it sees the new Facts immediately.
3. `memory_updates_message` is shown on stderr with the `🧠` prefix. When the batch contains any non-global Scope, the **deepest resolved non-global Scope** is shown as a `(prettyPath)` prefix before the message. Global-only batches show the bare message. Picking the deepest keeps the UI honest about which project the fact belongs to when a single update touches multiple levels.

### LLM Schema Coupling

The `memory_updates` entry's `scope` field is an absolute directory path (or `/`). Inline comments in the Zod schema guide the LLM's scoping decisions — these comments are extracted into `SCHEMA_TEXT` and shipped to the LLM on every request. Editing the schema therefore edits the prompt; see `.claude/skills/editing-prompts.md`.

---

## Out of Scope

- Memory TTL / expiry (schema leaves room to add it)
- Compaction / deduplication beyond exact-match
- `wrap memory` subcommand
- Size limits / token budget warnings
- Auto-probing a new CWD on first visit — project Facts emerge organically from use
- Memory editing / deletion UI
