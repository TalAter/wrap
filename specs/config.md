# Config

How Wrap resolves user-settable values — the precedence rule, the registry, the store, the disk schema, the first-run wizard.

> **Status:** Implemented.

---

## Sources and precedence

A setting can come from up to four places, highest priority first:

1. **CLI flag** (`--verbose`, `--model`, `--no-animation`)
2. **Environment variable** (`WRAP_MODEL`, `WRAP_NO_ANIMATION`, ...)
3. **Config file** (`~/.wrap/config.jsonc`, or the whole config as JSON via `WRAP_CONFIG`)
4. **Default** (from the SETTINGS registry)

Per-setting: `finalValue = cli ?? env ?? file ?? default`.

The resolver **always rebuilds from layers**. Never incremental-merges onto the store. Each `setConfig` call receives a complete `ResolvedConfig` where defaults are re-applied as the lowest layer, so a seeded CLI value never gets "overwritten" by a later file read — both are layered fresh in the right order.

---

## SETTINGS registry — `src/config/settings.ts`

Canonical list of user-settable values. Each entry declares available sources (`flag`, `env`), metadata (`description`, `usage`, `help`), and an optional `default`. A setting may appear in any subset of `{flag, env, config}`.

Setting key === Config key, implicitly. Exception: `model` is **virtual** — its value is resolved separately (see below) and never written to a `model` config field.

The registry is the single source of truth for:

- The CLI options array (derived in `src/subcommands/registry.ts` from entries with `flag`)
- Per-flag help output (description, usage, help, env var names)
- Defaults materialized by the resolver
- Naming convention across flag / env / config

Adding a setting means one entry. No drift because nothing else hand-lists them.

---

## Resolver — `src/config/resolve.ts`

`resolveSettings(modifiers, env, fileConfig) → ResolvedConfig`

- **Boolean sources:** CLI flag presence → `true`. Env var presence (any value, even empty string) → `true`. Undefined otherwise.
- **String sources:** CLI flag value, or env var value.
- **File layer:** any field not in SETTINGS (like `providers`) passes through untouched.

### `model` is virtual

`--model anthropic:claude-opus` doesn't write a `model` field. It's read by `resolveProvider` (see `llm.md`) which:

- Parses `provider:model`, `provider`, `:model`, or bare `model` (smart match)
- Picks the entry from `config.providers` or overrides `defaultProvider`
- Keeps the `providers` map otherwise unchanged

The resolver skips the `model` key entirely. `main.ts` passes the resolved string directly to `resolveProvider`.

### `noAnimation` aggregation

`config.noAnimation` is the only "should we animate?" state. At resolve time it folds user intent and env-wide capability signals:

```
config.noAnimation = userSays(cli/env/file) || CI || TERM=dumb || NO_COLOR
```

`CI`, `NO_COLOR`, `TERM` are environment signals, not settings. They feed into `noAnimation` only.

Per-stream TTY (e.g. `stderr.isTTY` for the chrome spinner) stays local at the call site — channel-specific, not a global signal. Pattern: `if (config.noAnimation || !stream.isTTY) skip animation`.

---

## Store — `src/config/store.ts`

`ResolvedConfig` is a `Config` where every SETTINGS-with-default field is required. The store only ever holds a `ResolvedConfig`:

- `setConfig(c: ResolvedConfig)` — strict; can't take a partial.
- `getConfig(): ResolvedConfig` — no cast needed at read sites; required fields are typed as defined.
- `updateConfig(patch: Partial<Config>)` — wizard's incremental builder. Skips keys whose patch value is `undefined` so a patch can't silently clear a required field.

A compile-time `_DriftCheck` type in `src/config/config.ts` fails to typecheck if SETTINGS grows a new default without ResolvedConfig gaining the matching required field. A runtime test in `tests/settings.test.ts` complements it for edge cases the type check can't catch.

Tests populate the store via `seedTestConfig()` in `tests/helpers.ts`, which funnels through the resolver.

### main.ts flow

```
parseArgs(argv)                             // strips modifier options
setConfig(resolveSettings(mods, env, {}))   // seed from CLI + env + defaults

if (flag subcommand) → dispatch, exit

fileConfig = ensureConfig()                 // wizard on missing config
setConfig(resolveSettings(mods, env, fileConfig))

override = modifiers.values.get("model") ?? env.WRAP_MODEL
resolved = resolveProvider(getConfig(), override)
...
```

Subcommands run against the seed — no file config — so they see CLI + env + defaults only.

---

## Disk format — `config.jsonc` and the schema

`config.jsonc` at `${WRAP_HOME}/config.jsonc` (`WRAP_HOME` defaults to `~/.wrap`). Supports JSONC (comments, trailing commas) via `jsonc-parser`.

`src/config/config.schema.json` ships alongside. It documents the file shape for editor/IDE validation. The wizard writes it at first run; it's bundled via static import so `bun build --compile` includes it.

> **Keep in sync:** any new setting that persists in config must get a matching entry in `config.schema.json` — otherwise editors won't know about it. The SETTINGS registry does not auto-generate the schema (yet).

`WRAP_CONFIG` env var — a full JSON config blob, shallow-merged on top of the file config at load time. Used by tests and for one-shot overrides.

---

## Config wizard

Interactive TUI that runs on first launch to write a valid `config.jsonc`. Replaces the dead-end `Config error: no LLM configured` message.

### Architecture

`ensureConfig()` in `src/config/ensure.ts` is called from `main.ts` in place of a plain `loadConfig`. If `config.jsonc` exists (or `WRAP_CONFIG` env is set), it returns the loaded file config. Otherwise it launches the wizard, writes the file, and returns the fresh config. Cancel → `process.exit(0)`.

The store is seeded by `main.ts` before `ensureConfig` runs, so wizard sections can freely call `getConfig()`/`updateConfig()` during the flow.

### Sections

The wizard is composed of independent sections that run sequentially. Each section is a self-contained React component rendered inside its own `<Dialog>` shell. Sections are unaware of each other.

Each section exports:
- A component: `(props: { onDone: (result: T) => void; onCancel: () => void; ...deps }) => JSX.Element`
- A result type `T`

Sections are individually mountable (future: `w --config-nerdfonts`, etc.). The orchestrator calls `updateConfig()` between sections so downstream sections pick up settings immediately (e.g. nerd icons turning on before providers display).

### Orchestrator

`config-wizard-dialog.tsx` tracks which section is active, accumulates results, and passes context forward. On final section completion, returns a unified `WizardResult`. Sections share the same wizard gradient; the `🧙 setup wizard` badge is shown on all sections except the welcome screen.

Current flow: `welcome` → `nerd-icons` → `providers` → done.

### WizardResult

```ts
type WizardResult = {
  entries: Record<string, ProviderEntry>;
  defaultProvider: string;
  nerdFonts?: boolean; // absent when nerd icons section wasn't shown
};
```

Mounted via `mountConfigWizardDialog()` in `src/session/dialog-host.ts`, which returns `Promise<WizardResult | null>`. Ink + React + dialog components are lazy-loaded via `preloadDialogModules()`.

### Providers state machine

Pure reducer in `src/wizard/state.ts`. Top-level fields (`modelsData`, `pickedProviders`, `builtEntries`, `defaultProvider`, `loopIndex`) hold accumulated state; a tagged `screen` union drives rendering:

`selecting-providers` → `loading-models` → per-provider loop (`entering-key` → `picking-model` | `disclaimer`) → `picking-default` (if >1 provider) → `done`

Reducer is unit-tested without Ink.

### Nerd Icons section

Binary detection screen. Shown always on interactive first run (TTY). CI/pipe skip the wizard entirely.

Icons used: `\udb82\udcd9` (Death Star), `\uf1d0` (Rebel), `\uedd6` (Republic), `\uf1d1` (Empire). All Nerd Font PUA codepoints.

- **Yes** → `{ nerdFonts: true }`. Orchestrator calls `updateConfig({ nerdFonts: true })` so `resolveIcon()` renders icons in later sections.
- **No** → `{ nerdFonts: false }`
- **Esc** → cancels entire wizard

### Provider data

Source of truth: `src/llm/providers/registry.ts`. Two maps: `API_PROVIDERS` (anthropic, openai, openrouter, groq, mistral, ollama) and `CLI_PROVIDERS` (claude-code). Object key order = display order.

**Why these providers:** Anthropic/OpenAI are primary. OpenRouter/Groq/Mistral all route via `openai-compat` kind with custom `baseURL`. Ollama is local-first. Google is deferred — its OpenAI-compat endpoint lacks structured-output support, requiring `@ai-sdk/google`. DeepSeek is excluded — only supports `json_object`, not `json_schema`.

### models.dev

URL `https://models.dev/api.json` cached at `~/.wrap/cache/models.dev.json` with 24h TTL via `fetchCached()` in `src/fs/cache.ts`. Fetched between Screen 1 and Screen 2 (loading spinner on bottom border). Offline first-run with no cache → clean error exit.

**Filter** (in `src/wizard/models-filter.ts`): text input+output modalities, `status !== "deprecated"`, `tool_call === true` (proxy for "modern chat model" — `structured_output` is under-reported in models.dev). Sorted by `release_date` desc.

**Recommendation:** If `recommendedModelRegex` matches, the newest match is promoted to row 0 and marked with `✦`.

### Providers section — screen flow

Linear, no back navigation.

- **Screen 1 — Provider selection.** `Checklist` with "API Providers" and "CLI Tools" group headers. Nerd icons shown per provider when enabled. `⏎ to continue` hint hidden until ≥1 selected. CLI section hidden if no binaries detected.
- **Screen 2 — Per-provider loop.** For each selected provider:
  - **2a (API key):** Masked `TextInput`, placeholder from registry. Skipped for ollama (no key) and CLI providers.
  - **2b (Model selection):** `@inkjs/ui` `Select` with filtered/sorted models. Enter-to-confirm via `useInput`.
  - **2c (CLI disclaimer):** Blocking message about routing through the CLI. Esc drops the provider.
- **Screen 3 — Default provider.** Skipped if only one provider.

### Write semantics

`writeWizardConfig()` in `src/wizard/write-config.ts`:

1. `config.jsonc` — `$schema` + `providers` + `defaultProvider` + `nerdFonts`, 2-space indent.
2. `config.schema.json` — copy of the bundled schema, overwritten every wizard run.
3. `cache/models.dev.json` — written indirectly by `fetchCached`.

Pre-write: every entry passes `validateProviderEntry()` before serialization. CLI providers write an empty entry (`{}`); `resolveProvider` allows this via `modelOptional` flag on CLI registrations.

### Cancellation

Esc on nerd icons screen or provider selection → abort, no file written, silent exit 0. Esc on disclaimer → skips that provider. Next `w` invocation re-triggers the wizard.

---

## Design decisions

- **Resolver rebuilds from layers, never merges onto the store.** Defaults stay in SETTINGS, never "become" config values that need overwriting by higher layers. Prevents the "default blocks file config" class of bug.
- **`noAnimation` aggregates environment signals at resolve time.** CI / TERM=dumb / NO_COLOR don't get separate checks at animation sites — they all fold into one `config.noAnimation`. Call sites check one thing.
- **`ResolvedConfig` is a distinct type from `Config`.** Config is the disk/file shape (partial). ResolvedConfig is the store shape (required fields materialized). The store API enforces this at the type level — no `as number` casts at read sites.
- **No back navigation in the wizard.** Keeps state machine simple; misclicks require re-running.
- **No API key validation.** The wizard never calls the provider API. Invalid keys fail at first real use.
- **`tool_call` as filter proxy.** models.dev under-reports `structured_output`. `tool_call: true` reliably identifies modern chat models.
- **CLI providers skip model selection.** CLI tools don't expose a reliable model list and their valid IDs change between versions.
- **Literal API keys in config.** v1 writes raw keys. Env-var `$VAR` reference form is deferred.
- **First-run wizard only.** Re-running over existing config needs preselect semantics (see `todo.md`).

---

## Future work

See `specs/todo.md` for tracked items. Notable ones tied to config:

- `--config` / `--init` flags — re-run wizard with preselect semantics.
- Env-var `$VAR` reference form for API keys, with detection + Tab-to-fill.
- Google (Gemini) support — requires `@ai-sdk/google`.
- Bundled models.dev snapshot for offline first-run.
- `WRAP_MAX_ROUNDS` and similar env vars for currently file-only settings (requires number/string env coercion in the resolver — infrastructure is ready, just add `env` to the SETTINGS entry).
- Auto-generate `config.schema.json` from SETTINGS to eliminate the manual sync.
