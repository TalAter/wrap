# Subcommands

> Subcommand = CLI sub-action accessed via a `--` flag (see `SPEC.md` §Glossary).

**Status:** Implemented.

---

## Why flags, not positional verbs

Wrap's first positional arg is natural language. `w log me in` must be a NL query, not a log viewer. Any `-` prefix on the first arg disambiguates — a leading `-` never appears in real NL input.

Detection is strictly positional: `w find files --verbose` is NL because `--verbose` isn't first. Modifier flags (`--verbose`, `--model`, `--provider`) are stripped from the front of argv *before* this check (see `src/core/input.ts`).

---

## Invariants

- **Short-circuit.** Subcommands run before `loadConfig()`, provider init, `ensureMemory()`, cwd probing. They handle their own prerequisites and must not depend on NL-mode setup.
- **Stdout discipline.** Each subcommand's "useful output" (help text, version string, log entries) goes to stdout. Everything else — errors, warnings, notices — uses `chrome()` (stderr/tty). See project-level stdout rule.
- **No args → `--help`.** `w` with no argv and no piped stdin dispatches to help.
- **Unknown flag → exit 1** with the specific flag name on stderr.
- **Registry is the single source of truth.** `--help` output, per-subcommand help, and dispatch all read from `src/subcommands/registry.ts`. Adding a subcommand is one registry entry; no other file lists flags.

---

## Architecture

Each `Subcommand` (`src/subcommands/types.ts`) is self-describing: `flag`, optional `aliases`, `description`, `usage`, optional long `help`, and `run(args)`. `dispatch()` matches flag-or-alias against the registry and passes remaining args through untouched — per-subcommand arg parsing is each command's job. There is no shared arg-schema layer; commands are few enough that a framework would be overkill.

Flow position in `main.ts`:

```
parseArgs(argv)           // strips modifier flags
  ├─ input.type === "flag" → dispatch(flag, args) → exit
  ├─ no input + no pipe    → dispatch("--help", []) → exit
  └─ otherwise             → loadConfig → provider → memory → runSession
```

---

## Current subcommands

| Flag | Aliases | Notes |
|---|---|---|
| `--help` | `-h` | Auto-generated from the registry. TTY: animated gradient logo. Non-TTY: plain text. `w --help <name>` prints per-subcommand detail from the registry entry's `usage`/`description`/`help`. |
| `--version` | `-v` | Reads `package.json`. Rejects extra args. |
| `--log` | — | Unified log viewer. |

### `--log` behaviour

```
w --log              # all entries, pretty
w --log 5            # last 5
w --log "error" 3    # search, then last 3 of matches
w --log --raw        # raw JSONL
```

Output mode picks itself:

- TTY + `jq` on PATH → piped through `jq -C .`
- TTY, no `jq` → `JSON.stringify(_, null, 2)`
- Non-TTY → raw JSONL (same as `--raw`)

Edge cases: missing log file → `No log entries yet.` on stderr, exit 0. Corrupt JSONL lines are skipped and counted; a stderr warning reports the skip count after valid entries print. When searching, all entries are read first and the `N` limit applies *after* the filter; without a search term `N` is applied at read time for efficiency.

---

## Out of scope

- `--config` — reuses the config wizard once that exists.
- `--memory` — view/manage memory store.
- Fuzzy "did you mean?" for unknown-flag typos.
