# Config Wizard

Interactive TUI that runs on first launch to write a valid `~/.wrap/config.jsonc`. Replaces the dead-end `Config error: no LLM configured` message for new users.

> **Status:** Nerd Icons section pending. Provider section implemented. Orchestrator pending.

## Architecture

`ensureConfig()` in `src/config/ensure.ts` replaces `loadConfig()` in `main.ts`. If `config.jsonc` exists (or `WRAP_CONFIG` env is set), it returns the loaded config. Otherwise it launches the wizard, writes the file, and returns fresh config. Cancel → `process.exit(0)`.

### Sections

The wizard is composed of independent **sections** that run sequentially. Each section is a self-contained React component with its own state, rendered inside its own `<Dialog>` shell. Sections are unaware of each other.

Each section exports:
- A React component: `(props: { onDone: (result: T) => void; onCancel: () => void; ...deps }) => JSX.Element`
- A result type `T` representing what the section produces

`ensureConfig()` seeds the config store with `setConfig({})` before launching the wizard (the store throws on read if uninitialized). The orchestrator never calls `setConfig()` itself — it only calls `updateConfig()` between sections so downstream code (e.g. `resolveIcon()` reading `getConfig().nerdFonts`) picks up settings immediately. This keeps the wizard safe to run later via `w --wizard` when a real config is already loaded. On wizard completion, `ensureConfig()` writes config to disk; `main.ts` then calls `setConfig()` with the final loaded config.

Future: individual sections can run standalone (e.g. `w --config-models`). Out of scope for now, but the section architecture supports it.

### Orchestrator

Lives in `config-wizard-dialog.tsx`. Tracks which section is active, accumulates results, and passes context forward. On final section completion, returns unified `WizardResult`. All sections share the same `🧙 setup wizard` badge and gradient.

Flow: `nerd-icons` → `providers` → done

### WizardResult

```ts
type WizardResult = {
  entries: Record<string, ProviderEntry>;
  defaultProvider: string;
  nerdFonts?: boolean; // absent when nerd icons section wasn't shown (standalone providers mode)
};
```

Mounted via `mountConfigWizardDialog()` in `src/session/dialog-host.ts`, which returns `Promise<WizardResult | null>`. Ink + React + dialog components are lazy-loaded via `preloadDialogModules()`.

### Providers state machine

Pure reducer in `src/wizard/state.ts`. Top-level fields (`modelsData`, `pickedProviders`, `builtEntries`, `defaultProvider`, `loopIndex`) hold accumulated state; a tagged `screen` union drives rendering:

`selecting-providers` → `loading-models` → per-provider loop (`entering-key` → `picking-model` | `disclaimer`) → `picking-default` (if >1 provider) → `done`

Reducer is unit-tested without Ink.

## Nerd Icons section

Binary detection screen. Shown always on interactive first run (TTY). CI/pipe already skip the wizard entirely.

**Screen:**
```
  Do you see four icons below?

  󰳼      

  > Yes — enable icons throughout Wrap
    No — they look like boxes or question marks

  ↑↓ to move  ⏎ to select
```

Icons: `\udb82\udcd9` (Death Star), `\uf1d0` (Rebel), `\uedd6` (Republic), `\uf1d1` (Empire). All Nerd Font PUA codepoints.

- **Yes** → result `{ nerdFonts: true }`. Orchestrator calls `updateConfig({ nerdFonts: true })` so `resolveIcon()` renders icons in subsequent sections.
- **No** → result `{ nerdFonts: false }`
- **Esc** → cancel entire wizard

**Result type:** `{ nerdFonts: boolean }`

## Provider data

### Registry

Source of truth: `src/llm/providers/registry.ts`.

Two maps: `API_PROVIDERS` (anthropic, openai, openrouter, groq, mistral, ollama) and `CLI_PROVIDERS` (claude-code). Object key order = display order. Each API provider carries `displayName`, `kind`, optional `apiKeyUrl`, `apiKeyPlaceholder`, `baseURL`, `recommendedModelRegex`. CLI providers carry `probeCmd` for `Bun.which()` detection.

**Why these providers:** Anthropic/OpenAI are primary. OpenRouter/Groq/Mistral all route via `openai-compat` kind with custom `baseURL`. Ollama is local-first. Google is deferred — its OpenAI-compat endpoint lacks structured-output support, requiring `@ai-sdk/google`. DeepSeek is excluded — only supports `json_object`, not `json_schema`.

### models.dev

URL `https://models.dev/api.json` cached at `~/.wrap/cache/models.dev.json` with 24h TTL via `fetchCached()` in `src/fs/cache.ts`. Fetched synchronously between Screen 1 and Screen 2 (loading spinner on bottom border). Offline first-run with no cache → clean error exit.

**Filter** (in `src/wizard/models-filter.ts`): text input+output modalities, `status !== "deprecated"`, `tool_call === true` (proxy for "modern chat model" — `structured_output` is under-reported in models.dev). Sorted by `release_date` desc.

**Recommendation:** If `recommendedModelRegex` matches, the newest match is promoted to row 0 and marked with `✦`. Others stay in release_date order.

## Providers section — screen flow

Linear, no back navigation.

**Screen 1 — Provider selection.** Custom `Checklist` with "API Providers" and "CLI Tools" group headers. Nerd icons shown per provider when enabled. `⏎ to continue` hint hidden until ≥1 selected. CLI section hidden if no binaries detected.

**Screen 2 — Per-provider loop.** For each selected provider in registry order:
- **2a (API key):** Masked `TextInput`, placeholder from registry. Skipped for ollama (no key) and CLI providers.
- **2b (Model selection):** `@inkjs/ui` `Select` with filtered/sorted models.dev list. `Select` has no `onSubmit` — Enter-to-confirm via `useInput` + local `onChange` state.
- **2c (CLI disclaimer):** Blocking message about routing through the CLI. Enter accepts; Esc drops the provider (bounces to Screen 1 if it was the only pick).

**Screen 3 — Default provider.** Skipped if only one provider. `Select` list of configured providers.

**Done.** Orchestrator collects result, writes config, calls `chrome("Configuration saved", "🧠")`, returns to `ensureConfig()`.

## Write semantics

The wizard writes via `writeWizardConfig()` in `src/wizard/write-config.ts`:

1. `config.jsonc` — `$schema` + `providers` + `defaultProvider` + `nerdFonts`, 2-space indent.
2. `config.schema.json` — copy of `src/config/config.schema.json` for editor support, bundled via static JSON import (survives `bun build --compile`), overwritten every wizard run.
3. `cache/models.dev.json` — written indirectly by `fetchCached`.

Pre-write validation: every entry passes `validateProviderEntry()` before serialization. CLI providers write an empty entry (`{}`); `resolveProvider` allows this via `modelOptional` flag on CLI registrations.

## Cancellation

Esc at any screen (except disclaimer, where Esc skips the provider) → abort, no file written, silent exit 0. Next `w` invocation re-triggers the wizard.

## Design decisions

- **No back navigation.** Keeps state machine simple; misclicks require re-running.
- **No API key validation.** The wizard never calls the provider API. Invalid keys fail at first real use.
- **`tool_call` as filter proxy.** models.dev under-reports `structured_output`. `tool_call: true` reliably identifies modern chat models. May need revisiting if it hides usable models.
- **CLI providers skip model selection.** CLI tools don't expose a reliable model list and their valid IDs change between versions. Letting the CLI own the default keeps Wrap out of that maintenance loop.
- **Literal API keys in config.** v1 writes raw keys. Env-var `$VAR` reference form is deferred (see Future work).
- **First-run only.** Re-running over existing config needs preselect semantics to avoid footgun overwrites.

## Future work

- **`w --config` / `w --init` flags.** Re-run wizard with preselect-from-current-config semantics — unchecking a provider removes it. Section architecture enables running individual sections standalone (e.g. `w --config-models`, `w --config-nerdfonts`).
- **Env-var detection + Tab-to-fill.** Auto-detect `$ANTHROPIC_API_KEY` etc. and offer `$VAR` reference form.
- **Google (Gemini) support.** Requires `@ai-sdk/google` + `kind: "google"` branch.
- **Bundled models.dev snapshot.** Offline first-run fallback.
- **"More providers…" picker.** Searchable list from models.dev with auto-populated `baseURL`.
- **Repair mode.** Auto-launch wizard on malformed existing config.
- **API key validation.** Verify key works before saving.
