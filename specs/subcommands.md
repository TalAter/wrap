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

- **Skip corrupt lines** with a stderr warning — even in raw mode. A corrupt line would break downstream `jq` parsing, so omitting it is the safer default.
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

### Subcommand Registry

Each subcommand is a self-describing object. All subcommands are registered in one place. `--help` is auto-generated from the registry — no hardcoded help text.

```ts
// src/subcommands/types.ts
type SubcommandArg = {
  name: string                    // display name: "N", "fact", etc.
  type: "number" | "string"
  required: boolean
}

type Subcommand = {
  flag: string                    // "--log"
  description: string             // "Show raw JSONL log entries"
  usage: string                   // "w --log [N]"
  arg?: SubcommandArg             // optional single arg spec
  run: (arg: string | number | null) => Promise<void>
}
```

```ts
// src/subcommands/registry.ts — single source of truth
import { logCmd, logPrettyCmd } from "./log"
// import { helpCmd } from "./help"      (future)
// import { versionCmd } from "./version" (future)

export const subcommands: Subcommand[] = [
  logCmd,
  logPrettyCmd,
]
```

Each subcommand lives in its own file under `src/subcommands/`. The registry imports them all.

### Dispatcher

The dispatcher handles arg validation generically before calling `run()`. Subcommands receive pre-validated args.

```ts
// src/subcommands/dispatch.ts (pseudo-code)
function dispatch(flag: string, rawArg: string | null): void {
  const cmd = subcommands.find(c => c.flag === flag)

  if (!cmd) {
    stderr(`Unknown flag: ${flag}`)
    process.exit(1)
  }

  // Arg validation
  if (cmd.arg?.required && rawArg === null) {
    stderr(`Missing argument: ${cmd.flag} requires <${cmd.arg.name}>.`)
    stderr(`Usage: ${cmd.usage}`)
    process.exit(1)
  }

  if (rawArg !== null && cmd.arg) {
    if (cmd.arg.type === "number") {
      const n = parseInt(rawArg, 10)
      if (isNaN(n) || n < 0) {
        stderr(`Invalid argument: ${cmd.flag} expects a number.`)
        stderr(`Usage: ${cmd.usage}`)
        process.exit(1)
      }
      return cmd.run(n)
    }
    return cmd.run(rawArg)
  }

  if (rawArg !== null && !cmd.arg) {
    stderr(`${cmd.flag} does not take an argument.`)
    process.exit(1)
  }

  return cmd.run(null)
}
```

### `--help` (auto-generated)

`--help` is a registered subcommand like any other. Its `run()` iterates the registry to build usage text. No hardcoded flag list.

```
$ w --help
wrap - natural language shell commands

Usage: w <prompt>         Run a natural language query

Flags:
  --log [N]               Show raw JSONL log entries
  --log-pretty [N]        Show formatted log entries
  --help                  Show this help
  --version               Show version
```

The preamble ("wrap - natural language...", "Usage: w <prompt>") is static text in the help subcommand. The flags table is built dynamically from `subcommands.map(c => ...)`.

### Flow position

```
parseInput(argv)
  │
  ├─ first arg starts with --? ──→ dispatch(flag, arg)  (exit)
  │
  ├─ ensureConfig()      // only for NL queries
  ├─ ensureMemory()
  └─ runQuery()
```

Subcommands short-circuit `main()` — they skip `ensureConfig()`, `ensureMemory()`, and `runQuery()`, and handle their own prerequisites instead. `--log` only needs `WRAP_HOME` (via `getWrapHome()`), not config or memory.

### Module structure

```
src/
  core/
    input.ts              Updated: flag detection
    output.ts             New: shared isTTY() / hasJq() utilities
  subcommands/
    types.ts              Subcommand type definition
    registry.ts           All subcommands registered here
    dispatch.ts           Arg validation + dispatch
    log.ts                --log and --log-pretty
    help.ts               --help (auto-generated from registry)
    version.ts            --version (reads from package.json)
```

### Input type update

```ts
type Input =
  | { type: "prompt"; prompt: string }
  | { type: "flag"; flag: string; arg: string | null }
  | { type: "none" }  // no args → help
```

Note: `parseInput()` no longer needs to know about specific flags. It just detects the `--` prefix and passes the raw flag + arg to the dispatcher, which checks the registry.

---

## Testing

### parseInput

- Returns `{ type: "flag" }` for `--log`, `--log 3`, `--log-pretty`
- Returns `{ type: "prompt" }` for `log me in`, `find --verbose files`
- Returns `{ type: "none" }` for no args

### Dispatcher

- Dispatches known flags to their `run()` function
- Errors on unknown `--` flags
- Validates arg type before calling `run()` (number validation for `--log`)
- Errors when required arg is missing
- Errors when unexpected arg is passed to no-arg flag

### --log

- Outputs all entries as raw JSONL
- `--log N` outputs last N entries
- No log file → stderr message, exit 0, empty stdout
- Corrupt lines → skips with stderr warning, shows valid entries
- N counts raw lines, not parsed entries

### --log-pretty

- Outputs indented JSON
- Uses jq when TTY + jq available (mock `Bun.which`)
- Falls back to JSON.stringify when piped or no jq

### --help

- Output includes all registered subcommands
- Adding a subcommand to registry automatically appears in --help

---

## Out of Scope

- `--config`, `--memory` subcommands
- "Did you mean?" fuzzy matching for typos
