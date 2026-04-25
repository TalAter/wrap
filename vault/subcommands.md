---
name: subcommands
description: CLI flags — subcommands and modifier options
Source: src/subcommands/, src/core/input.ts, src/config/settings.ts
Last-synced: 0a22f2a
---

# Subcommands

## Why flags, not positional verbs

Wrap's first positional arg is natural language. `w log me in` must stay NL. A leading `--` disambiguates — never appears in real NL input. Modifier options are stripped from leading argv first, then the first arg is checked.

## Two kinds

- **Commands** — short-circuit subcommands (`--help`, `--version`, `--log`, `--completion`, `--forget`). Run before config/provider/memory init; handle their own prerequisites.
- **Modifier options** — strip from argv and tweak a query without branching (`--model`, `--verbose`, `--no-animation`).

A single registry drives help, dispatch, and the modifier parser. Modifier options are derived from the settings registry (entries with a `flag`) — no manual sync between config and CLI. See [[config]].

## Behaviour

- No args + no pipe → `--help`. No args + pipe → empty user prompt; piped content is the context. See [[piped-input]].
- Unknown flag → exit 1 with the offending flag on stderr.
- `--forget` deletes persisted user data; `--yolo` skips its dialog. See [[forget]].
- `--verbose` writes a curated pipeline trace to stderr — a human subset of what logs capture. See [[logging]].
