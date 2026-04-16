---
name: wizard
description: Interactive TUI that writes a valid config.jsonc on first run
Source: src/wizard/, src/tui/config-wizard-dialog.tsx
Last-synced: c54a1a5
---

# Wizard

Interactive TUI that runs when `w` is invoked with no config. Walks the user through provider selection, nerd-icon preference, and defaults, then writes `config.jsonc` and `config.schema.json`.

The wizard is composed of independent **sections** that run sequentially. Each section is a self-contained React component rendered inside its own `<Dialog>` shell. Sections are unaware of each other; the orchestrator passes results forward by calling `updateConfig()` between them so later sections read settings (like `nerdFonts`) through [[config]]'s store. Sections are individually mountable by design.

## Integration

[[config]]'s store is seeded before `ensureConfig` runs, so wizard sections can call `getConfig()` / `updateConfig()` freely.

Ink + React + the wizard module are lazy-loaded the first time the wizard actually mounts, so their weight stays off the hot path when config already exists.

Cancellation exits silently with status 0; the next `w` invocation re-triggers the wizard.

## Section model

Each section exports a component with the shape `(props: { onDone: (result: T) => void; onCancel: () => void; ...deps }) => JSX.Element` and a result type `T`.

Current flow: `welcome` → `nerd-icons` → `providers` → `done`. All sections except welcome share the wizard gradient and the `🧙 setup wizard` badge.

### WizardResult

```ts
type WizardResult = {
  entries: Record<string, ProviderEntry>;
  defaultProvider: string;
  nerdFonts?: boolean;
};
```

`nerdFonts` is optional: a section run may not touch it, and it may already be set by config file, env, or flag.

## Providers section

The largest section. A pure reducer in `src/wizard/state.ts` drives a tagged `screen` union:

`selecting-providers` → `loading-models` → per-provider loop (`entering-key` → `picking-model` | `disclaimer`) → `picking-default` (only if >1 provider) → `done`.

The reducer is unit-tested without Ink.

### Screen flow

Linear, no back navigation.

1. **Provider selection.** Checklist with "API Providers" and "CLI Tools" group headers. Nerd icons shown per provider when enabled. `⏎ to continue` hint hidden until at least one is selected. The CLI section is hidden if no CLI binaries are detected.
2. **Per-provider loop.** For each selected provider:
   - API key entry (masked text input, placeholder from registry). Skipped for `ollama` and all CLI providers.
   - Model selection (filtered, sorted `Select`). Skipped for CLI providers — their model list and valid IDs change between versions, so they skip model selection entirely.
   - CLI disclaimer (blocking message about routing through the CLI). Esc drops that provider.
3. **Default provider.** Skipped if only one provider was chosen.

### Provider data

The registry at `src/llm/providers/registry.ts` is the source of truth. Object key order drives display order. Two maps: `API_PROVIDERS` (Anthropic, OpenAI, OpenRouter, Groq, Mistral, Ollama) and `CLI_PROVIDERS` (Claude Code). See [[llm]] for the taxonomy.

Google is deferred — its OpenAI-compat endpoint lacks structured-output support and needs `@ai-sdk/google`. DeepSeek is excluded — only supports `json_object`, not `json_schema`.

### models.dev integration

`https://models.dev/api.json`, cached at `~/.wrap/cache/models.dev.json` with 24h TTL via `fetchCached()` in `src/fs/cache.ts`. Fetched between the provider-selection screen and the first model screen, with a loading spinner on the dialog's bottom border.

Offline first-run with no cache → clean error exit.

**Filter** (in `src/wizard/models-filter.ts`): text input+output modalities, status is not `deprecated`, `tool_call === true` (see Decisions). Sorted by `release_date` desc.

**Recommendation:** if `recommendedModelRegex` matches, the newest match is promoted to row 0 and marked with `✦`.

## Nerd-icons section

Binary detection screen. Shown on interactive first run (TTY). CI and pipe-invocations skip the wizard entirely.

Icons used are Nerd Font PUA codepoints: Death Star (`\udb82\udcd9`), Rebel (`\uf1d0`), Republic (`\uedd6`), Empire (`\uf1d1`).

Result: `{ nerdFonts: true | false }`. The orchestrator calls `updateConfig({ nerdFonts })` immediately so later sections render icons accordingly. Esc cancels the entire wizard.

## Writing

`writeWizardConfig()` in `src/wizard/write-config.ts` writes three files:

1. `config.jsonc` — `$schema`, `providers`, `defaultProvider`, `nerdFonts`. 2-space indent.
2. `config.schema.json` — copy of the bundled schema, overwritten every wizard run.
3. `cache/models.dev.json` — written indirectly by `fetchCached` during the providers flow.

Every entry passes `validateProviderEntry()` before serialization. CLI providers write an empty entry (`{}`); `resolveProvider` allows this via the registry's `modelOptional` flag.

## Cancellation

- Esc on nerd-icons or provider-selection → abort, no file written.
- Esc on CLI disclaimer → skip that provider; rest of flow continues.

## Decisions

- **No back navigation.** Keeps the state machine simple; misclicks require re-running. Back-stack semantics would cost more than they save.
- **No API-key validation.** Wizard never calls a provider. Invalid keys fail at first real use with a clearer error than a probe could give.
- **`tool_call: true` as filter proxy.** models.dev under-reports `structured_output`; `tool_call` reliably identifies modern chat models.
- **CLI providers skip model selection.** Their valid IDs change between versions; writing an empty entry and letting the CLI pick beats freezing a stale list.
- **Literal API keys in config.** `$VAR` reference form is deferred. See `ideas/todo.md`.
- **Re-running over existing config not yet supported.** Needs preselect semantics. See `ideas/todo.md`.
