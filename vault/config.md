---
name: config
description: Config sources, precedence, registry, and disk format
Source: src/config/
Last-synced: 0a22f2a
---

# Config

## Precedence

Highest priority first: CLI flag → env var → config file → default.

Per-setting: `cli ?? env ?? file ?? default`. The resolver always rebuilds from layers — never incremental-merges onto the store. Prevents "default blocks file config" bugs.

## Settings registry

Single source of truth for the list of user-settable values. Drives the CLI options array, per-flag help, defaults, and the naming convention across flag/env/config. Adding a setting is one entry — no drift between layers.

## Resolved vs. on-disk shape

The disk shape is partial; the in-memory store has every defaulted field required. Distinct types so read sites need no casts. A compile-time drift check fails if the registry grows a default without the store gaining the matching required field.

Boolean env vars accept the usual truthy/falsy spellings; anything else throws.

## Virtual `model`

`--model` doesn't write a `model` field. It's parsed (`provider:model`, `provider`, `:model`, bare `model`) and selects from `config.providers`. Setting key = config key everywhere except here. See [[llm]].

## `noAnimation` aggregation

Folds user intent and env capability at resolve time: user opt-out OR `CI` OR `TERM=dumb` OR `NO_COLOR`. Per-stream TTY check stays at the call site. One signal at use sites instead of scattered env checks.

## Disk format

`config.jsonc` at `$WRAP_HOME/config.jsonc`. JSONC (comments, trailing commas). A bundled JSON schema ships for editor validation; the wizard writes it on first run. Schema is hand-maintained — the registry does not auto-generate it.

`WRAP_CONFIG` env var carries a full JSON blob shallow-merged on top. Used by tests and one-shot overrides; bypasses the wizard.
