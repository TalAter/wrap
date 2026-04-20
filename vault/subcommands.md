---
name: subcommands
description: CLI flags — subcommands (--log, --help, --version) and modifier options (--verbose, --model, --no-animation)
Source: src/subcommands/, src/core/input.ts, src/config/settings.ts
Last-synced: c54a1a5
---

# Subcommands

## Why flags, not positional verbs

Wrap's first positional arg is natural language. `w log me in` must be NL, not a log viewer. A leading `--` disambiguates — never appears in real NL input.

Detection is positional: modifier options are stripped from leading argv first (see `src/core/input.ts`), then the first arg is checked.

## Architecture

`CLIFlag` is a discriminated union:
- **Command** (`kind: "command"`) — `run(args)`. Invoked when first non-option arg is a known flag.
- **Option** (`kind: "option"`) — `takesValue`. Stripped from leading argv by `extractModifiers()`. `id` becomes the key in the `Modifiers` map.

Registry at `src/subcommands/registry.ts` is the single source of truth. Options derived from SETTINGS registry — entries with a `flag` become Options automatically. See [[config]].

## Commands

| Flag | Aliases | Notes |
|---|---|---|
| `--help` | `-h` | Auto-generated from registry. TTY: animated gradient logo. `w --help <name>` prints per-flag detail. |
| `--version` | `-v` | Reads `package.json`. |
| `--log` | — | Log viewer. See [[logging]]. |
| `--forget` | — | Delete persisted user data (memory, logs, cache, temp files). `--yolo` skips the interactive dialog. See [[forget]]. |

## Modifier options

| Flag | Aliases | Env | Notes |
|---|---|---|---|
| `--model` | `--provider` | `WRAP_MODEL` | Override provider/model. Formats: `provider:model`, `provider`, `:model`, bare `model`. |
| `--verbose` | — | — | Curated pipeline output on stderr: config, probes, LLM calls, executions. Human-friendly subset of what logs capture. Format: `» [+elapsed_s] message` in dim ANSI. |
| `--no-animation` | — | `WRAP_NO_ANIMATION` | Disable animations. Also triggered by `CI`, `TERM=dumb`, `NO_COLOR`. |

## Invariants

- **Short-circuit.** Commands run before `ensureConfig`, provider init, memory. Handle their own prerequisites.
- **No args + no pipe → `--help`.** No args + pipe → empty user prompt (the piped content is the context). See [[piped-input]].
- **Unknown flag → exit 1** with specific flag name on stderr.

## Decisions

- **Registry is single source of truth.** Help, dispatch, modifier parser all read from it. Adding a flag = one entry.
- **Options derived from SETTINGS.** No manual sync between config and CLI flags.
