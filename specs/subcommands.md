# Subcommands — Implementation Spec

> **Date:** 2026-03-23
> **Status:** Ready for implementation

---

## Overview

Subcommands use `--` flags to avoid colliding with natural language input. The `--` prefix is a definitive signal: once you type it, you're in flag-land, not NL-land.

```
w --log           # subcommand
w --log 3         # subcommand with arg
w log me in       # natural language (untouched)
```

---

## Detection Mechanism

### Flag parsing in `parseInput()`

Check the first arg for a `--` prefix. If it matches a known flag, return a subcommand input. If it starts with `--` but isn't known, error immediately.

```ts
// Pseudo-code
const firstArg = args[0]

if (firstArg?.startsWith("--")) {
  const known = KNOWN_FLAGS[firstArg]
  if (!known) {
    stderr(`Unknown flag: ${firstArg}`)
    process.exit(1)
  }
  return { subcommand: known.name, arg: args[1] ?? null }
}

// Otherwise: natural language prompt
return { prompt: args.join(" ") }
```

### Rules

- Only the **first arg** is checked for flags. `w find files with --verbose` is NL — `--verbose` isn't the first arg.
- Unknown `--` flags error immediately: `Unknown flag: --verbose`
- Each flag takes **0 or 1 argument** (the next token). No multi-arg flags.
- Subcommands **short-circuit** the main flow — they run before `ensureConfig()` / `ensureMemory()` and handle their own prerequisites.

### Error messages

```
$ w --logg 3
Unknown flag: --logg

$ w --log foo
Invalid argument: --log expects a number.
Usage: w --log [N]
```

Errors go to stderr, exit 1.

---

## `--log` — Raw Log Output

Dumps raw JSONL log entries to stdout.

```bash
w --log           # all entries (raw JSONL)
w --log 3         # last 3 entries
w --log 1         # last entry
```

### Behavior

| Input | Output | Exit |
|---|---|---|
| `w --log` | All entries, one JSONL line per entry, to stdout | 0 |
| `w --log N` | Last N entries (counting raw lines, not parsed entries) | 0 |
| `w --log` (no log file) | stderr: `No log entries yet.` | 0 |
| `w --log foo` | stderr: error + usage hint | 1 |

### Corrupt JSONL lines

Log files can have partial lines from crashes mid-write. Handling:

- **Skip corrupt lines** with a stderr warning
- Show all parseable entries
- Warning format: `Warning: skipped N corrupt log entries`
- When counting "last N", count raw lines (including corrupt ones). If a corrupt line falls within the last N, the user gets fewer valid entries + the warning.

### Output

- stdout: raw JSONL (one JSON object per line, no formatting)
- stderr: warnings (corrupt lines), empty-state message
- Exit 0 in all cases except invalid arguments

---

## `--log-pretty` — Formatted Log Output

Same as `--log` but with formatted output.

```bash
w --log-pretty        # all entries, formatted
w --log-pretty 3      # last 3 entries, formatted
```

### Formatting strategy

Progressively enhanced based on environment:

| Condition | Output |
|---|---|
| stdout is TTY **and** jq is installed | Pipe through `jq .` (colorized + indented) |
| stdout is TTY, no jq | `JSON.stringify(entry, null, 2)` (indented, no color) |
| stdout is piped | `JSON.stringify(entry, null, 2)` (indented, no color) |

- **jq detection:** `Bun.which("jq")` — synchronous, essentially free
- **TTY detection:** `process.stdout.isTTY` — shared utility from `src/core/tty.ts` (used throughout the app for color output, confirmation TUI, etc.)
- Entries separated by a blank line for readability

### Same edge cases as `--log`

Corrupt lines, empty state, N counting — all behave identically to `--log`.

---

## Architecture

### Flow position

```
parseInput(argv)
  │
  ├─ --flag detected? ──→ runSubcommand()  (exit)
  │     └─ --log: resolves WRAP_HOME, reads log file, outputs
  │     └─ --log-pretty: same + formatting
  │
  ├─ ensureConfig()      // only for NL queries
  ├─ ensureMemory()
  └─ runQuery()
```

Subcommands resolve their own prerequisites. `--log` only needs `WRAP_HOME` (via `getWrapHome()`), not config or memory.

### Module structure

```
src/
  core/
    input.ts            Updated: flag detection + subcommand parsing
    tty.ts              New: shared isTTY() utility
  subcommands/
    log.ts              --log and --log-pretty implementation
```

### Input type update

```ts
type Input =
  | { type: "prompt"; prompt: string }
  | { type: "subcommand"; name: string; arg: string | null }
  | { type: "none" }  // no args → help
```

---

## Testing

- `parseInput` returns subcommand for `--log`, `--log 3`, `--log-pretty`
- `parseInput` returns prompt for `log me in`, `find --verbose files`
- `parseInput` errors on unknown flags (`--foo`)
- `--log` outputs all entries as raw JSONL
- `--log N` outputs last N entries
- `--log` with no log file → stderr message, exit 0, empty stdout
- `--log` with corrupt lines → skips with stderr warning, shows valid entries
- `--log-pretty` outputs indented JSON
- `--log-pretty` uses jq when TTY + jq available (mock `Bun.which`)
- `--log-pretty` falls back to JSON.stringify when piped or no jq
- Invalid arg (`--log foo`) → stderr error + usage, exit 1
- N counts raw lines, not parsed entries

---

## Out of Scope

- `--help`, `--version` (deferred — unknown flag error catches them for now)
- `--config`, `--memory`, other subcommands
- "Did you mean?" fuzzy matching for typos
- LLM self-discovery of Wrap's own flags (see `specs/prompts/llm-tool-discovery.md`)
