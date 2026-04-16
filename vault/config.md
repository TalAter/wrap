---
name: config
description: Config sources, precedence, SETTINGS registry, resolver, store, and disk schema
Source: src/config/
Last-synced: c54a1a5
---

# Config

## Precedence

A setting can come from up to four places, highest priority first:

1. **CLI flag** (`--verbose`, `--model`, `--no-animation`)
2. **Environment variable** (`WRAP_MODEL`, `WRAP_NO_ANIMATION`, …)
3. **Config file** (`~/.wrap/config.jsonc`, or full JSON via `WRAP_CONFIG`)
4. **Default** (from SETTINGS registry)

Per-setting: `finalValue = cli ?? env ?? file ?? default`. The resolver always rebuilds from layers — never incremental-merges onto the store.

## SETTINGS registry

`src/config/settings.ts` — canonical list of user-settable values. Each entry declares sources (`flag`, `env`), metadata (`description`, `usage`, `help`), and optional `default`.

Single source of truth for:
- CLI options array (derived from entries with `flag`)
- Per-flag help output
- Defaults materialized by the resolver
- Naming convention across flag / env / config

Adding a setting = one entry. No drift.

## Resolver

`resolveSettings(modifiers, env, fileConfig) → ResolvedConfig`

- Boolean sources: CLI flag presence → `true`. Env var value parsed: `1/true/yes/on` → true; `0/false/no/off/""` → false (case-insensitive, trimmed); other values throw.
- String sources: CLI flag value or env var value.
- File layer: fields not in SETTINGS (like `providers`) pass through.

### `model` is virtual

`--model anthropic:claude-opus` doesn't write a `model` field. `resolveProvider` parses `provider:model`, `provider`, `:model`, or bare `model` (smart match) and selects the entry from `config.providers`. Falls back to `defaultProvider` when no override given. The resolver skips `model` entirely. See [[llm]].

### `noAnimation` aggregation

Folds user intent and env-wide capability signals at resolve time:

`config.noAnimation = userSays(cli/env/file) || CI || TERM=dumb || NO_COLOR`

Per-stream TTY stays local at call site: `if (config.noAnimation || !stream.isTTY) skip animation`.

## Store

`ResolvedConfig` is `Config` with every SETTINGS-with-default field required.

- `setConfig(c: ResolvedConfig)` — strict, can't take a partial.
- `getConfig(): ResolvedConfig` — no casts at read sites.
- `updateConfig(patch)` — wizard's incremental builder. Skips `undefined` keys.

A compile-time `_DriftCheck` type fails if SETTINGS grows a default without `ResolvedConfig` gaining the matching required field. Runtime test complements it.

## Disk format

`config.jsonc` at `${WRAP_HOME}/config.jsonc`. Supports JSONC (comments, trailing commas) via `jsonc-parser`. `config.schema.json` ships bundled for editor validation; wizard writes it at first run.

`WRAP_CONFIG` env var — full JSON blob, shallow-merged on top of file config. Used by tests and one-shot overrides. When set, `ensureConfig()` skips the wizard.

**Keep in sync:** new settings that persist in config need a matching entry in `config.schema.json` — SETTINGS does not auto-generate the schema.

## Decisions

- **Rebuild from layers, never merge onto store.** Prevents "default blocks file config" bugs.
- **`noAnimation` aggregates env signals at resolve time.** One check at call sites, not scattered `CI` / `TERM=dumb` checks.
- **`ResolvedConfig` distinct from `Config`.** Disk shape is partial; store shape has required fields. No `as number` casts.
- **Setting key = config key.** Except `model`, which is virtual.
