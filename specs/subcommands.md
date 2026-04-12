# CLI flags

> CLIFlag = any `--` flag Wrap accepts, either a **command** (sub-action like `--log`) or an **option** (modifier like `--verbose`). See `SPEC.md` §Glossary.

**Status:** Implemented.

---

## Why flags, not positional verbs

Wrap's first positional arg is natural language. `w log me in` must be a NL query, not a log viewer. Any `-` prefix on the first arg disambiguates — a leading `-` never appears in real NL input.

Detection is strictly positional: `w find files --verbose` is NL because `--verbose` isn't first. Options (`--verbose`, `--model`, `--provider`) are stripped from the front of argv *before* this check (see `src/core/input.ts`).

---

## Invariants

- **Short-circuit.** Commands run before `ensureConfig()`, provider init, `ensureMemory()`, cwd probing. They handle their own prerequisites and must not depend on NL-mode setup.
- **Stdout discipline.** Each command's "useful output" (help text, version string, log entries) goes to stdout. Everything else — errors, warnings, notices — uses `chrome()` (stderr/tty). See project-level stdout rule.
- **No args → `--help`.** `w` with no argv and no piped stdin dispatches to help.
- **Unknown flag → exit 1** with the specific flag name on stderr.
- **Registry is the single source of truth.** `--help` output, per-flag help, dispatch, and the modifier parser all read from `src/subcommands/registry.ts`. Adding a flag — command or option — is one registry entry; no other file lists flags.

---

## Architecture

`CLIFlag` (`src/subcommands/types.ts`) is a discriminated union with two variants, sharing `flag`, optional `aliases`, `id`, `description`, `usage`, and optional long `help`:

- **`Command`** (`kind: "command"`) adds `run(args)`. Invoked by `dispatch()` when the first non-option argv is a known flag.
- **`Option`** (`kind: "option"`) adds `takesValue`. Stripped from leading argv positions by `extractModifiers()` in `src/core/input.ts` before command dispatch or NL parsing. `id` becomes the key in the resulting `Modifiers` map (e.g. `--model` → `modelOverride`).

`main.ts` derives the modifier parser input from the registry's `options` array, so adding an option to the registry automatically makes it parseable and visible in help. `dispatch()` reads `commands` and passes remaining args through untouched — per-command arg parsing is each command's job.

Flow position in `main.ts`:

```
parseArgs(argv)           // strips options (--verbose, --model, ...)
  ├─ input.type === "flag" → dispatch(flag, args) → exit
  ├─ no input + no pipe    → dispatch("--help", []) → exit
  └─ otherwise             → ensureConfig → provider → memory → runSession
```

---

## Current flags

**Commands:**

| Flag | Aliases | Notes |
|---|---|---|
| `--help` | `-h` | Auto-generated from the registry. TTY: animated gradient logo. Non-TTY: plain text. `w --help <name>` prints per-flag detail (command or option) from its registry entry. |
| `--version` | `-v` | Reads `package.json`. Rejects extra args. |
| `--log` | — | Unified log viewer. |

**Options:**

| Flag | Aliases | Value | Notes |
|---|---|---|---|
| `--model` | `--provider` | required | Override LLM provider/model for this invocation. Formats: `provider:model`, `provider`, `:model`, or bare `model` (smart match). See `llm.md`. |
| `--verbose` | — | none | Enable real-time narrative debugging on stderr. See `verbose.md`. |

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
