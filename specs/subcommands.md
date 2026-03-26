# Subcommands

> Subcommands use `--` flags to avoid colliding with natural language input.

> **Status:** Implemented — registry, dispatch, `--help`, `--version`, `--log` all working.

---

## Design

The `--` prefix is a definitive signal: once you type it, you're in flag-land, not NL-land. Only the **first arg** is checked — `w find files with --verbose` is NL because `--verbose` isn't first.

```
w --log           # subcommand
w --log 3         # subcommand with arg
w log me in       # natural language
```

**Rules:**
- Unknown `--` flags error immediately with the specific flag name.
- Subcommands **short-circuit** the main flow — they run before `loadConfig()` / `ensureMemory()` and handle their own prerequisites.
- No args (`w` with nothing) → dispatches to `--help`.
- Errors go to stderr, exit 1.

---

## Architecture

### Registry Pattern

Each subcommand is a self-describing object with `flag`, `description`, `usage`, and a `run(args)` function. All subcommands are registered in `src/subcommands/registry.ts`. `--help` is auto-generated from the registry — no hardcoded flag list.

Each subcommand handles its own argument parsing from the `args` string array. The dispatcher (`src/subcommands/dispatch.ts`) only matches the flag against the registry and passes remaining args through — no generic type checking per-subcommand.

### Flow Position

```
parseInput(argv)
  │
  ├─ first arg starts with --? ──→ dispatch(flag, args)  (exit)
  ├─ no args? ──→ dispatch("--help", [])  (exit)
  │
  ├─ loadConfig()       // only for NL queries
  ├─ initProvider()
  ├─ ensureMemory()
  └─ runQuery()
```

---

## Current Subcommands

### `--help`

Auto-generated from the registry. TTY-aware: animated gradient rendering when stdout is a TTY, plain text fallback when piped.

### `--version`

Reads from `package.json`, prints to stdout.

### `--log`

Unified log viewer — pretty by default, raw with `--raw` flag.

```bash
w --log              # all entries, pretty-printed (jq when available)
w --log 5            # last 5 entries
w --log "error" 3    # search for "error" in last 3 entries
w --log --raw        # raw JSONL output
```

**Pretty output** adapts to environment:
- TTY + jq installed → pipes through `jq -C .` (colorized + indented)
- TTY, no jq → `JSON.stringify(entry, null, 2)` (indented, no color)
- Piped → raw JSONL (same as `--raw`)

**Edge cases:**
- No log file → stderr: `No log entries yet.`, exit 0
- Corrupt JSONL lines → skipped with stderr warning, valid entries shown
- Search reads all entries then filters; N limit applies after search

---

## Out of Scope

- `--config` — manual reconfigure (reuses config wizard when built)
- `--memory` — view/manage memory
- "Did you mean?" fuzzy matching for unknown flag typos
