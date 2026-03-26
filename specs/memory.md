# Memory System — Implementation Spec

> **Date:** 2026-03-25
> **Status:** Ready for implementation

---

## Overview

Memory lets Wrap learn and remember facts about the user's environment. Facts are persisted to disk and included in every LLM request, so the LLM can generate better commands without redundant probes.

Each fact has a **scope** — a directory it applies to. Facts scoped to `/` are global and always sent. Facts scoped to a specific directory are only sent when CWD is that directory or a subdirectory. This lets Wrap learn per-project knowledge — tooling, test commands, build systems — without polluting every request.

On first run, Wrap probes the system, sends raw output to the LLM to parse into concise facts, and saves them as global facts. Subsequent runs load memory from disk. Project-specific facts emerge organically during use — the LLM discovers project tooling (lockfiles, config files) and returns memory updates with the appropriate scope.

---

## Storage

### File

- **File:** `~/.wrap/memory.json` (flat, alongside `config.jsonc`)
- **Path resolution:** Uses shared `getWrapHome()` from `src/core/home.ts`
- **Directory creation:** Create `~/.wrap/` lazily — only when first writing `memory.json`.

### Format

Map of scope (resolved absolute path) → fact objects:

```ts
type Fact = { fact: string };          // future: add `expires?: number`
type Memory = Record<string, Fact[]>;

// Keys are resolved absolute paths. '/' is the global scope.
// Facts within each scope are ordered by insertion time (append-only).
// Keys are sorted alphabetically on write ('/' first, then by path depth naturally).
```

```json
{
  "/": [
    {"fact": "Runs macOS Darwin 25.3.0 on arm64 (Apple Silicon)"},
    {"fact": "Default shell is zsh, config at ~/.zshrc (symlinked to iCloud)"},
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

### Zod schema for validation

```ts
import { z } from "zod";

const FactSchema = z.object({ fact: z.string() });
const MemoryFileSchema = z.record(z.string(), z.array(FactSchema));
```

On load, parse with `MemoryFileSchema.safeParse()`. If it fails for any reason (invalid JSON, wrong shape, old array format):

```
⚠️ Memory error: ~/.wrap/memory.json is broken — delete the file and run Wrap again.
```

Use `prettyPath` for the path in the error message so it reflects the actual `WRAP_HOME` (e.g., if overridden for testing). Single error message. No format-specific diagnostics.

### Write semantics

- **Append-only within each scope.** New facts are pushed to the end of the array for their scope.
- **Newer facts (higher index) take precedence** over older contradicting facts. The LLM is told this in the prompt.
- **Keys sorted alphabetically on every write.** This ensures `/` comes first and longer paths (more specific scopes) come after shorter ones. This order is preserved when reading — no runtime sorting needed at prompt assembly time.
- Having the keys (directories) sorted alphabetically means facts for subdirectories appear after facts for their parent directories ensuring the more specific facts appear later in the prompt.
- Scopes that don't exist on disk (verified by `resolvePath`) are silently discarded — the fact is not saved.

---

## Path Utilities

Two new shared utilities in `src/core/paths.ts`:

```ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve a path to its canonical absolute form (synchronous).
 * Expands ~, resolves relative paths against `cwd`, resolves symlinks,
 * normalizes /private/var → /var on macOS.
 * Returns null if the path does not exist on disk.
 */
export function resolvePath(p: string, cwd?: string): string | null {
  try {
    let expanded = p.startsWith("~")
      ? p.replace("~", homedir())
      : p;
    if (cwd && !expanded.startsWith("/")) {
      expanded = resolve(cwd, expanded);
    }
    return realpathSync(expanded);
  } catch {
    return null;
  }
}

/**
 * Display a path with ~ substituted for the home directory prefix.
 * For use in user-facing messages (stderr). Never for storage or prompt injection.
 */
export function prettyPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}
```

### Usage rules

- **Storage and prompt injection:** always use resolved absolute paths (from `resolvePath`).
- **User-facing chrome messages:** always use `prettyPath`.
- **CWD:** resolved once at startup in `main.ts` via `resolvePath(process.cwd())`, passed through as context.

---

## Data Flow

Memory exists in different shapes at different boundaries. This section defines each one explicitly.

### 1. On disk → `loadMemory`

```ts
// Fact and Memory types defined in Storage section above

function loadMemory(wrapHome: string): Memory
// Returns {} if file doesn't exist.
// Throws on corrupt/invalid file.
```

### 2. `main.ts` → `runQuery` (transport)

The full memory map is passed through, along with the resolved CWD. `runQuery` doesn't filter — it passes both to context assembly.

```ts
// main.ts
const cwd = resolvePath(process.cwd())!; // resolved once at startup
const memory = await ensureMemory(provider, getWrapHome());
process.exit(
  await runQuery(input.prompt, provider, {
    memory,        // Memory (full map)
    cwd,           // resolved absolute path
    providerConfig: config.provider,
  }),
);
```

### 3. `assembleCommandPrompt` (prompt assembly)

`context.ts` receives the full map + resolved CWD. It filters scopes by CWD prefix match and formats into sections.

```ts
type QueryContext = {
  prompt: string;
  cwd: string;                              // resolved absolute path
  memory: Memory;                     // full map, filtering happens here
  threadHistory?: ConversationMessage[];
  pipedInput?: string;
};
```

### 4. LLM response → `appendFacts`

The LLM returns `{fact, scope}[]`. A new function resolves paths and appends to the map:

```ts
// memory.ts
function appendFacts(
  wrapHome: string,
  updates: Array<{ fact: string; scope: string }>,
  cwd: string,  // resolved CWD — used to resolve relative scope paths
): Memory
// For each update:
//   1. resolvePath(scope, cwd) → if null, silently discard
//   2. Append Fact to the end of the array for that resolved scope
//   3. Sort keys alphabetically, persist
// Returns the updated Memory map so the caller can update its in-memory state.
// (The next LLM call in the same loop must see the new facts.)
```

### 5. query.ts call site

```ts
if (response.memory_updates?.length) {
  memory = appendFacts(wrapHome, response.memory_updates, cwd);
  if (response.memory_updates_message) {
    // Show scope prefix only for non-global facts.
    // Use the longest (most specific) resolved scope from the batch.
    const scopes = response.memory_updates
      .map(u => resolvePath(u.scope, cwd))
      .filter((s): s is string => s !== null && s !== "/");
    const deepest = scopes.sort((a, b) => b.length - a.length)[0];
    const prefix = deepest
      ? `🧠 (${prettyPath(deepest)}) `
      : "🧠 ";
    chrome(`${prefix}${response.memory_updates_message}`);
  }
}
```

### Type summary

| Boundary | Type | Shape |
|----------|------|-------|
| On disk | `Memory` | `Record<string, Fact[]>` — scope is the key, facts are the values |
| main → query | `Memory` + `cwd` | Full map + resolved CWD |
| query → context | `QueryContext.memory` | `Memory` (filtered in context.ts) |
| LLM response | `memory_updates` | `{fact: string, scope: string}[]` — fact bundled with its destination scope |
| context → prompt | Formatted text | Sectioned markdown |

### Types cleanup

`MemoryEntry` (in `memory.ts`) and `MemoryFact` (in `types.ts`) are currently duplicate `{fact: string}` types. Both are replaced by `Fact`. Remove `MemoryFact` from `types.ts` and `MemoryEntry` from `memory.ts`.

---

## LLM Response Schema

Update `memory_updates` in `CommandResponseSchema`:

```ts
// Reusable facts learned about the user's environment.
// These are saved and given to you in future requests.
memory_updates: z
  .array(
    z.object({
      // The fact to remember
      fact: z.string(),
      // Absolute directory path this fact applies to.
      // Use "/" for system-wide facts (installed tools, OS, shell).
      // Use the project's root directory for project-specific facts
      // (tooling, test commands, build systems).
      // Default to "/" unless the fact is clearly project-specific.
      scope: z.string(),
    }),
  )
  .nullable()
  .optional(),
// Human-readable summary of what was learned. Shown to the user as-is. Single message covering all updates.
memory_updates_message: z.string().nullable().optional(),
```

Update the Zod schema in `src/command-response.schema.ts` — the inline comments above each field are extracted into `SCHEMA_TEXT` in `src/prompt.optimized.ts` (auto-generated) and read by the LLM on every request. They serve as the primary guidance for scoping decisions.

---

## Prompt Assembly

### Filtering

For each scope in stored order (alphabetical), include it if CWD is that directory or a subdirectory.

**Prefix match must use trailing slashes** to avoid false positives with sibling directories (e.g., `/monorepo` matching `/monorepo-tools`). Append `/` to both CWD and scope before comparing:

```ts
const cwdSlash = cwd.endsWith("/") ? cwd : cwd + "/"
const scopeSlash = scope.endsWith("/") ? scope : scope + "/";
const matches = cwdSlash.startsWith(scopeSlash);
```

Scopes are stored without trailing slashes (as `realpathSync` returns them, except `/` which naturally has one). The trailing-slash append is only for comparison.

Keys are stored sorted alphabetically, and alphabetical order naturally produces shorter paths before longer ones (a parent is always a prefix of its child, so it sorts earlier). This gives global-to-specific ordering without runtime sorting. **More specific facts appear later in the prompt, closer to the user's request, leveraging the LLM's recency bias.** Do not re-sort scopes at read time. Do not reorder facts within a scope. Insertion order = chronological order.

This method will always include global facts because `cwdSlash.startsWith('/')` is always true.

### Format

```
## System facts
- Runs macOS Darwin 25.3.0 on arm64 (Apple Silicon)
- Installed: git, docker, node, python3, bun, curl, jq

## Facts about /Users/tal/monorepo
- Uses bun
- Run tests with `bun run test`

## Facts about /Users/tal/monorepo/packages/api
- Uses postgres
- Run tests with `make test`
```

- `/` scope → section header `## System facts`
- All other scopes → `## Facts about {resolved_path}`
- Paths in headers are full resolved absolute paths (not pretty `~` form) so the LLM can reference and return them.
- Sections only appear if they have facts after filtering.
- If no facts match at all, omit the entire facts block.

### Recency instruction

Add to the system prompt:

```
When multiple memory facts contradict each other, the later (more recent) fact is more current and should take precedence.
```

### CWD in prompt

The working directory line in the prompt (`Working directory (cwd): ...`) must use `resolvePath` output for consistency with scope paths.

---

## Init Flow

Called from `main()` after `loadConfig()` and `initProvider()`.

```
ensureMemory(provider, wrapHome)
  │
  ├─ memory.json exists and has at least one scope key?
  │    (Object.keys(memory).length > 0)
  │    ──→ load and return Memory
  │
  └─ first run (file missing or empty map):
       ├─ run local probe commands (no LLM)
       ├─ show "✨ Learning about your system..." on stderr
       ├─ send raw probe output to LLM via provider.runPrompt()
       ├─ parseInitResponse() returns Fact[] (unchanged — plain text, one fact per line)
       ├─ ensureMemory wraps result as { "/": facts }
       ├─ save to memory.json
       ├─ show summary: "🧠 Detected: macOS arm64, zsh, brew, git, docker..."
       └─ return Memory
```

If the LLM call fails → **error and exit**. If we can't reach the LLM for memory init, we can't reach it for the user's query either.

**Wrap hardcodes the scope to `/` for all init-generated facts.** The init LLM prompt and response format do not change — no `scope` field in the init response. The init flow uses a dedicated prompt and its own plain-text response parsing (not the Zod command response schema).

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

Response parsing: split by newlines, trim whitespace, strip bullet prefixes, filter empty lines, wrap each in `{fact: string}`.

### Init UX

All output goes to stderr (stdout is sacred).

1. Spinner with message: `✨ Learning about your system...`
2. After LLM responds, single summary line built from raw probe results (no LLM needed for this):
   `🧠 Detected OS, shell, git, docker, node, bun, curl, jq`
   - "OS, shell" are hardcoded — always detected, not worth parsing from probe output
   - Tool names extracted from `which` output: lines containing `/` are found tools, take the basename. Lines with "not found" are skipped.

---

## Runtime Memory Updates

When the LLM returns `memory_updates` in a query response:

1. Call `appendFacts(wrapHome, updates, cwd)` which, for each update `{fact, scope}`:
   a. Resolves `scope` via `resolvePath(scope, cwd)`. Relative paths (`.`, `./src`) are resolved against CWD.
   b. If `resolvePath` returns `null` (path doesn't exist) → **silently discards** this fact.
   c. Otherwise, appends `{fact}` to the end of the array for that resolved scope.
   d. Sorts the top-level map keys (scope paths) alphabetically. Does not reorder facts within any scope.
   e. Persists to disk and returns the updated `Memory` map.
2. Update the in-memory state so the next LLM call in the same loop sees the new facts.
3. Show `memory_updates_message` on stderr (see query.ts call site above for display logic).

---

## Eval Examples

Eval examples test that the LLM responds correctly given various memory states in the prompt. These are single-turn: the prompt includes pre-populated memory sections and we verify the LLM's response.

- [ ] Contradicting facts within the same scope — LLM uses the later (more recent) fact
- [ ] Contradicting facts across scopes (global says npm, directory says bun) — LLM uses the more specific scope
- [ ] Memory says "uses bun" for CWD — LLM generates `bun run test` not `npm test`
- [ ] Memory says a tool is not installed — LLM avoids that tool or suggests an alternative
- [ ] No memory for CWD — LLM returns a probe or uses only global facts
- [ ] LLM returns `memory_updates` with correct `scope` (global vs directory) based on what it learned

### Future (requires probe loop)

- [ ] Probe response reveals project tooling → LLM returns memory update scoped to that directory

---

## Testing

Same pattern as config: **temp directories**. Each test gets its own `WRAP_HOME` pointing to an isolated tmp dir. No interface abstraction for mocking — test real I/O against isolated filesystem.

### Memory I/O

- `loadMemory()` returns empty map `{}` when file doesn't exist
- `loadMemory()` parses valid memory file
- `loadMemory()` throws on corrupt / old-format file with the expected error message
- `saveMemory()` writes keys in sorted order
- `saveMemory()` preserves fact order within each scope
- `appendFacts()` pushes fact to end of existing scope
- `appendFacts()` creates new scope if it doesn't exist
- `appendFacts()` discards facts with non-existent scope paths
- `appendFacts()` resolves relative scope paths against CWD
- `appendFacts()` returns updated Memory map

### Path utilities

- `resolvePath("~")` returns homedir
- `resolvePath(".")` returns CWD
- `resolvePath("./src", "/Users/tal/project")` returns `/Users/tal/project/src`
- `resolvePath("/nonexistent")` returns `null`
- `prettyPath("/Users/tal/foo")` returns `"~/foo"`
- `prettyPath("/usr/local")` returns `"/usr/local"` (not under home)
- `prettyPath(homedir())` returns `"~"`

### Prompt assembly

- Only matching scopes included
- `/` facts always included
- Subdirectory CWD matches parent scope
- Unrelated directory scope excluded
- Sibling directory with shared prefix excluded (e.g., `/monorepo` does not match CWD `/monorepo-tools`)
- Sections ordered global → specific (by alphabetical key order)
- Facts within scope preserve insertion order
- Recency instruction appears in system prompt

### Init

- Facts saved under `/` scope in new map format
- `ensureMemory` returns `Memory`

### Runtime updates

- Memory update saved to correct scope
- Invalid scope path silently discarded
- `memory_updates_message` shown with directory prefix for non-global facts
- CWD in prompt uses resolved path

**Do not limit yourself to just these tests. We should be fully test driven. Always write a failing test first**

---

## Module Structure

```
src/
  core/
    paths.ts             NEW — resolvePath(), prettyPath()
  memory/
    memory.ts            MODIFIED — new storage format, Zod validation,
                         Memory type, appendFacts()
    init-prompt.ts       UNCHANGED
    init-probes.ts       UNCHANGED
  llm/
    context.ts           MODIFIED — prompt assembly with scope filtering, recency note,
                         QueryContext.memory becomes Memory
    types.ts             MODIFIED — remove MemoryFact (replaced by Memory)
  command-response.schema.ts  MODIFIED — scope field in memory_updates, inline comments for LLM guidance
  prompt.optimized.ts    MODIFIED — auto-regenerated from schema, recency in SYSTEM_PROMPT
```

---

## Out of Scope

- Memory TTL / expiry (future — storage format supports adding fields to fact objects)
- Memory compaction / deduplication
- `wrap memory` subcommand (separate feature)
- Memory size limits / token budget warnings
- Auto-probing CWD on first visit (project-specific facts emerge organically from use)
- Migration from old format (single user; delete and re-init)

---

## Implementation Plan

Each step is a standalone commit with all tests passing.

### Step 1: Path utilities

New file `src/core/paths.ts`. Pure addition, no callers.

- `resolvePath(p, cwd?)` — sync, `realpathSync`, expands `~`, resolves relative paths against `cwd`, returns `null` for non-existent
- `prettyPath(p)` — substitutes home prefix with `~`
- Tests for all cases including relative paths with `cwd` param

### Step 2: Rename types

`MemoryEntry` (memory.ts) and `MemoryFact` (types.ts) → `Fact` (memory.ts). Mechanical rename across all files: memory.ts, types.ts, context.ts, query.ts, tests. No behavior change.

### Step 3a: New storage format — load/save layer

- Define `Memory = Record<string, Fact[]>`
- Add `MemoryFileSchema` (Zod) for validation
- `loadMemory` → returns `Memory` (`{}` if no file). Single error: `"⚠️ Memory error: ~/.wrap/memory.json is broken — delete the file and run Wrap again."`
- `saveMemory` → takes `Memory`, sorts top-level keys alphabetically on write
- Tests: load empty, load valid map, load corrupt/old-format, save sorts keys, save preserves fact order

### Step 3b: Callers — ensureMemory, appendMemory, context, query

- `ensureMemory` → wraps init facts as `{"/": [...]}`, returns `Memory`
- `appendMemory` → loads map, appends to `"/"` scope, saves (same caller API, internal change)
- `context.ts` → `QueryContext.memory` becomes `Memory`; temporarily flatten all values into single `## Known facts` list
- `query.ts` → `options.memory` becomes `Memory`, pass through to context
- `main.ts` → receives `Memory` from `ensureMemory`, passes to `runQuery`
- Update all tests (ensure-memory, context, index/e2e, helpers)

### Step 4: Resolve CWD at startup

- `main.ts` → `const cwd = resolvePath(process.cwd())!`, pass to `runQuery`
- `runQuery` options gains `cwd: string`, passes to `assembleCommandPrompt`
- CWD line in prompt now uses resolved path
- Tests: verify resolved CWD in prompt output

### Step 5: Add `scope` to LLM response schema

- `CommandResponseSchema`: add `scope: z.string()` (required) with inline comments guiding scoping decisions
- `SCHEMA_TEXT` and `PROMPT_HASH` in `prompt.optimized.ts` will be regenerated automatically from the updated Zod schema (can also be hand-edited during development — the optimizer will overwrite before release)
- `query.ts`: update `appendMemory` call to pass scope — temporarily extract facts and default scope to `"/"` until Step 6 replaces with `appendFacts` (e.g., `appendMemory(wrapHome, response.memory_updates.map(u => ({fact: u.fact})))`)
- Tests: schema validation accepts/rejects with scope field

### Step 6: `appendFacts` replaces `appendMemory`

- Rename `appendMemory` → `appendFacts(wrapHome, updates: {fact, scope}[], cwd)`
- Resolves each scope via `resolvePath(scope, cwd)` — handles relative paths
- Discards facts with invalid scope paths silently
- Appends to correct scope in map, sorts keys, persists
- Returns updated `Memory` map
- `query.ts`: calls `appendFacts`, updates in-memory `memory` with returned value for next loop iteration
- Tests: append to `/`, to directory scope, relative scope, invalid scope discarded, return value

### Step 7: Scoped prompt assembly

- `context.ts`: filter memory by CWD prefix match using trailing-slash comparison
- Sectioned format: `## System facts` for `/`, `## Facts about {resolved_path}` for others (full absolute paths in headers)
- Sections in stored key order (alphabetical = global → specific)
- Omit sections with no matching facts, omit entire block if no facts
- Add recency instruction to `SYSTEM_PROMPT` in `prompt.optimized.ts`
- Tests: prefix match, sibling exclusion (`/monorepo` vs `/monorepo-tools`), ordering, empty memory

### Step 8: Display scope in stderr

- `query.ts`: from the current `response.memory_updates` batch, find the longest resolved non-`/` scope
- Non-global facts present: `🧠 ({prettyPath(deepest)}) {message}`
- All global: `🧠 {message}`
- Tests for display logic

### Step 9: Eval examples

- Contradicting facts within the same scope — LLM uses the later fact
- Contradicting facts across scopes — LLM uses the more specific scope
- Memory says "uses bun" for CWD — LLM generates bun commands
- Memory says a tool is not installed — LLM avoids it
- No memory for CWD — LLM probes or uses global facts only
- LLM returns `memory_updates` with correct `scope` based on what it learned
