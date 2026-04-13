# Config Wizard

Interactive TUI that runs on first launch to write a valid `~/.wrap/config.jsonc`. Replaces the dead-end `Config error: no LLM configured` message for new users.

> **Status:** Implemented. All screens, state machine, provider registry, model filter, config writer, and `ensureConfig()` wiring are complete.

## Architecture

`ensureConfig()` in `src/config/ensure.ts` replaces `loadConfig()` in `main.ts`. If `config.jsonc` exists (or `WRAP_CONFIG` env is set), it returns the loaded config. Otherwise it launches the wizard, writes the file, and returns fresh config. Cancel → `process.exit(0)`.

The wizard updates the global config store (`updateConfig()`) between sections — e.g. after the nerd-font screen completes, subsequent screens can read `getConfig().nerdFonts` to render icons. The wizard's own state machine handles wizard-specific state (provider loop, model selection); shared display settings flow through the config store. On completion, `main.ts` calls `setConfig()` with the final loaded config.

### Component structure

- **`Dialog`** (`src/tui/dialog.tsx`) — generic bordered-chrome. Gradient bars, top/bottom borders, optional badge, `bottomStatus`, terminal centering. Knows nothing about content.
- **`ConfigWizardDialog`** (`src/tui/config-wizard-dialog.tsx`) — the wizard. Multi-screen state machine rendered inside `<Dialog>` with wizard-specific gradient stops and `🧙 setup wizard` badge.
- **`Checklist`** (`src/tui/checklist.tsx`) — custom multi-select with `✓`/`·` indicators and group headers. Used for Screen 1 provider selection.

Mounted via `mountConfigWizardDialog()` in `src/session/dialog-host.ts`, which returns `Promise<WizardResult | null>`. Ink + React + both dialog components are lazy-loaded via `preloadDialogModules()`.

### State machine

Pure reducer in `src/wizard/state.ts`. Top-level fields (`modelsData`, `pickedProviders`, `builtEntries`, `defaultProvider`, `loopIndex`) hold accumulated state; a tagged `screen` union drives rendering:

`selecting-providers` → `loading-models` → per-provider loop (`entering-key` → `picking-model` | `disclaimer`) → `picking-default` (if >1 provider) → `done`

Reducer is unit-tested without Ink.

## Provider data

### Registry

Source of truth: `src/llm/providers/registry.ts`.

Two maps: `API_PROVIDERS` (anthropic, openai, openrouter, groq, mistral, ollama) and `CLI_PROVIDERS` (claude-code). Object key order = display order. Each API provider carries `displayName`, `kind`, optional `apiKeyUrl`, `apiKeyPlaceholder`, `baseURL`, `recommendedModelRegex`. CLI providers carry `probeCmd` for `Bun.which()` detection.

**Why these providers:** Anthropic/OpenAI are primary. OpenRouter/Groq/Mistral all route via `openai-compat` kind with custom `baseURL`. Ollama is local-first. Google is deferred — its OpenAI-compat endpoint lacks structured-output support, requiring `@ai-sdk/google`. DeepSeek is excluded — only supports `json_object`, not `json_schema`.

### models.dev

URL `https://models.dev/api.json` cached at `~/.wrap/cache/models.dev.json` with 24h TTL via `fetchCached()` in `src/fs/cache.ts`. Fetched synchronously between Screen 1 and Screen 2 (loading spinner on bottom border). Offline first-run with no cache → clean error exit.

**Filter** (in `src/wizard/models-filter.ts`): text input+output modalities, `status !== "deprecated"`, `tool_call === true` (proxy for "modern chat model" — `structured_output` is under-reported in models.dev). Sorted by `release_date` desc.

**Recommendation:** If `recommendedModelRegex` matches, the newest match is promoted to row 0 and marked with `✦`. Others stay in release_date order.

## Screen flow

Four screens, linear, no back navigation.

**Screen 1 — Provider selection.** Custom `Checklist` with "API Providers" and "CLI Tools" group headers. Intro prose orients first-time users. `⏎ to continue` hint hidden until ≥1 selected. CLI section hidden if no binaries detected.

**Screen 2 — Per-provider loop.** For each selected provider in registry order:
- **2a (API key):** Masked `TextInput`, placeholder from registry. Skipped for ollama (no key) and CLI providers.
- **2b (Model selection):** `@inkjs/ui` `Select` with filtered/sorted models.dev list. `Select` has no `onSubmit` — Enter-to-confirm via `useInput` + local `onChange` state.
- **2c (CLI disclaimer):** Blocking message about routing through the CLI. Enter accepts; Esc drops the provider (bounces to Screen 1 if it was the only pick).

**Screen 3 — Default provider.** Skipped if only one provider. `Select` list of configured providers.

**Screen 4 — Done.** No visible screen. Writes config, calls `chrome("Configuration saved", "🧠")`, returns to `ensureConfig()`.

## Write semantics

The wizard writes via `writeWizardConfig()` in `src/wizard/write-config.ts`:

1. `config.jsonc` — `$schema` + `providers` + `defaultProvider`, 2-space indent.
2. `config.schema.json` — copy of `src/config/config.schema.json` for editor support, bundled via static JSON import (survives `bun build --compile`), overwritten every wizard run.
3. `cache/models.dev.json` — written indirectly by `fetchCached`.

Pre-write validation: every entry passes `validateProviderEntry()` before serialization. CLI providers write an empty entry (`{}`); `resolveProvider` allows this via `modelOptional` flag on CLI registrations.

## Cancellation

Esc at any screen (except disclaimer, where Esc skips the provider) → abort, no file written, silent exit 0. Next `w` invocation re-triggers the wizard.

## Design decisions

- **No back navigation.** Wizard is 4 screens max. Keeps state machine simple; misclicks require re-running.
- **No API key validation.** The wizard never calls the provider API. Invalid keys fail at first real use.
- **`tool_call` as filter proxy.** models.dev under-reports `structured_output`. `tool_call: true` reliably identifies modern chat models. May need revisiting if it hides usable models.
- **CLI providers skip model selection.** CLI tools don't expose a reliable model list and their valid IDs change between versions. Letting the CLI own the default keeps Wrap out of that maintenance loop.
- **Literal API keys in config.** v1 writes raw keys. Env-var `$VAR` reference form is deferred (see Future work).
- **First-run only.** Re-running over existing config needs preselect semantics to avoid footgun overwrites.

## Future work

- **`w --config` / `w --init` flags.** Re-run wizard with preselect-from-current-config semantics — unchecking a provider removes it.
- **Env-var detection + Tab-to-fill.** Auto-detect `$ANTHROPIC_API_KEY` etc. and offer `$VAR` reference form.
- **Google (Gemini) support.** Requires `@ai-sdk/google` + `kind: "google"` branch.
- **Bundled models.dev snapshot.** Offline first-run fallback.
- **"More providers…" picker.** Searchable list from models.dev with auto-populated `baseURL`.
- **Repair mode.** Auto-launch wizard on malformed existing config.
- **API key validation.** Verify key works before saving.
