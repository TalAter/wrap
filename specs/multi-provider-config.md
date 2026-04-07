# Multi-Provider Config

> Restructure of `config.jsonc` so users can configure multiple LLM providers and switch the default one without losing other providers' credentials.

> **Status:** Spec only. Not implemented.

---

## Motivation

Today the config has a single `provider` block. Switching providers means rewriting it from scratch — the previous provider's API key is lost. Users want:

1. Persist credentials for several providers in one place.
2. Switch the persistent default provider/model.
3. Use a different provider for a single run without touching the file.

---

## Config Shape

```jsonc
{
  "$schema": "./config.schema.json",

  "providers": {
    "anthropic":   { "apiKey": "$ANTHROPIC_API_KEY", "model": "claude-haiku-4-5" },
    "openai":      { "apiKey": "$OPENAI_API_KEY",    "model": "gpt-4o-mini" },
    "ollama":      { "baseURL": "http://localhost:11434/v1", "model": "llama3.2" },
    "claude-code": { "model": "sonnet" },
    "groq":        { "baseURL": "https://api.groq.com/openai/v1", "apiKey": "$GROQ_KEY", "model": "llama-3.1-70b-versatile" }
  },

  "defaultProvider": "anthropic"
}
```

Two top-level keys replace the old `provider` block:

- **`providers`** — map keyed by user-facing provider name. Each value is a `ProviderEntry` whose allowed fields depend on the name (see below). Every entry carries its own `model`.
- **`defaultProvider`** — name of the entry in `providers` to use when no `--model` override is set.

**Why model lives inside the provider entry:** A model only makes sense paired with the provider that serves it. Storing them together makes file-level drift structurally impossible — switching `defaultProvider` switches its model in lockstep. The wizard (out of scope) writes a per-provider model when the user picks one. Wrap still never *picks* a model — the user does, once per provider they configure. (Runtime overrides via `--model` can still pair a provider with a transient model the API rejects — see § Resolution.)

---

## Provider Names

The map key is the user-facing provider name. Wrap's source maps each known name to an internal SDK factory — that mapping is invisible to the user.

### Known providers (v1)

| Name          | Allowed fields                          | Internal binding                          |
|---------------|-----------------------------------------|-------------------------------------------|
| `anthropic`   | `apiKey?`, `baseURL?`, `model`          | ai-sdk anthropic                          |
| `openai`      | `apiKey?`, `baseURL?`, `model`          | ai-sdk openai                             |
| `ollama`      | `baseURL` *(required)*, `model`         | ai-sdk openai-compat, placeholder apiKey  |
| `claude-code` | `model`                                 | `claude` CLI subprocess                   |

`apiKey` resolution rules unchanged from `specs/llm-sdk.md` § AI SDK Provider — `$VAR` reads env, omitted reads provider's default env var, literal used as-is.

The internal `test` provider is **not** user-facing. It is selected by setting `WRAP_TEST_RESPONSE`, which short-circuits `resolveProvider` and bypasses the providers map entirely. See § Test Provider.

### Unknown providers (escape hatch)

Any other key is treated as an OpenAI-compatible endpoint. The user picks the name (`groq`, `together`, `fireworks`, …). **Required:** `baseURL`, `apiKey`, and `model`. Without `apiKey`, the call would silently use a placeholder string against a real billed endpoint — runtime rejects the entry.

---

## Resolution

Layered precedence (lowest → highest):

1. **`config.jsonc`** in `WRAP_HOME`
2. **`WRAP_CONFIG`** env var — top-level shallow merge over file
3. **`WRAP_MODEL`** env var — overrides which provider and/or which model is used for this run
4. **`--model`** CLI flag — same semantics as `WRAP_MODEL`, wins over env

Shallow merge (layer 2) is consistent across all top-level keys. Each top-level key (`providers`, `defaultProvider`, `maxRounds`, …) is independently overridable. **Nested objects are replaced wholesale, not deep-merged** — this is the gotcha:

```
file:        providers={anthropic:{...}, openai:{...}}, defaultProvider=anthropic
WRAP_CONFIG: {"providers":{"openai":{"apiKey":"$NEW","model":"gpt-4o"}}}
result:      providers={openai:{apiKey:"$NEW",model:"gpt-4o"}}  ← anthropic is GONE
```

Setting `providers` from `WRAP_CONFIG` replaces the **entire** map. To override just which provider/model is used without redefining the map, use `WRAP_MODEL` or `--model`.

If both `WRAP_MODEL` and `--model` are set, `--model` wins entirely — values are not field-merged.

### `--model` / `--provider` value parsing

`--provider` is an alias for `--model`. Both flags accept the same values and parse identically. (`--model` is the canonical flag because the bare-string smart resolution path is most often a model name; `--provider` reads better when the value is a provider name. They're interchangeable.) `WRAP_MODEL` uses the same parsing rules.

A "transient" model below means: used for this run only, not written back to the config file.

```
--model anthropic:claude-opus-4-5   → use anthropic, with transient model claude-opus-4-5
--model anthropic                   → use anthropic, with anthropic.model from config
--model :claude-opus-4-5            → use defaultProvider, with transient model claude-opus-4-5
--model claude-opus-4-5             → smart: matches anthropic.model in config → use anthropic
--model gpt-9999                    → smart: matches no configured provider/model → defaultProvider with transient
```

Parsing rules:
- Split on the **first** `:` only. `--model openai:gpt-4o:turbo` → provider=`openai`, model=`gpt-4o:turbo`.
- Empty value (`--model ""` / `WRAP_MODEL=""`) or bare `:` → `Config error: --model value is empty.`
- No `:` → **smart resolution**, in order:
  1. Match against keys of the merged `providers` map → provider override (use that entry's stored model).
  2. Match against `providers[*].model` values across the merged map → if exactly one entry has it, use that entry. If multiple entries share the model string, error: `Config error: model "X" is configured for multiple providers; use provider:model.`
  3. No match → model override on `defaultProvider` (transient).
- Provider override naming a **known** built-in that is **not configured** (e.g. `--model openai` when openai is absent from `providers`) → `Config error: provider "openai" not found in config.` Smart resolution looks at *configured* names, not built-in names.

Smart resolution is purely local — it inspects the merged config map and never queries any provider's API.

If a transient model isn't supported by the resolved provider (e.g. `--model :gpt-4o` while `defaultProvider` is `anthropic`), Wrap passes it through to the SDK. The SDK rejects the call; the error is wrapped with a Wrap-prefixed message before printing, so users don't see raw SDK chrome on stderr.

`WRAP_MODEL` and `--model` resolve against the **merged** providers map (file ⊕ `WRAP_CONFIG`). The override layer never sees the raw file map alone.

### Where `--model` / `--provider` parsing lives

`parseArgs` (`src/core/input.ts`) recognizes both flags as value-taking modifiers and extracts the **raw string** into `Modifiers.modelOverride: string | undefined`. Both `--model foo` and `--model=foo` forms are accepted (same for `--provider`). The flag must appear before the prompt. Today's `extractModifiers` only handles boolean modifiers — it must be extended to support value-taking ones.

All splitting, smart resolution, and provider lookup happens in `resolveProvider` in the LLM layer (see Internal Type).

### Override scope

The flag/env override **only** swaps which provider entry and which model are used. `apiKey` and `baseURL` always come from the resolved entry in `providers`. There is no flag for ad-hoc credentials — edit config or set env vars.

Omitted `apiKey` on a known provider continues to fall back to the SDK's default env var (e.g. `ANTHROPIC_API_KEY`) whether the entry was reached via `defaultProvider` or via override. The override path doesn't disable the fallback.

---

## Internal Type

`loadConfig` returns the file/env-merged `Config`. A new pure function in the LLM layer resolves it into the final state used by `initProvider`:

```ts
type Config = {
  providers?:       Record<string, ProviderEntry>;
  defaultProvider?: string;
  // ...other top-level fields unchanged
};

type ProviderEntry = {
  apiKey?:  string;
  baseURL?: string;
  model?:   string;   // required at runtime for every entry
};

type ResolvedProvider = {
  name:     string;   // e.g. 'anthropic', 'ollama', 'groq'
  model:    string;   // e.g. 'claude-haiku-4-5'
  apiKey?:  string;
  baseURL?: string;
};

function resolveProvider(
  config: Config,
  override?: string,   // raw value from CLI (--model) OR env (WRAP_MODEL); CLI wins, caller resolves
): ResolvedProvider;
```

The caller picks `override` from `Modifiers.modelOverride` if set, else `process.env.WRAP_MODEL`, else `undefined`. `resolveProvider` then parses it (split on first colon, smart-resolve bare values), applies the override on top of `defaultProvider`, looks up the entry in the merged providers map, and returns the final tuple.

`initProvider(resolved)` dispatches on `resolved.name`:

- `anthropic` → ai-sdk anthropic factory
- `openai` → ai-sdk openai factory
- `ollama` → ai-sdk openai factory with the entry's `baseURL` (required), placeholder apiKey
- `claude-code` → claude-code subprocess provider
- *anything else* → ai-sdk openai factory with the entry's `baseURL` and `apiKey`

This replaces today's `ProviderConfig` discriminated union and the `type` field. The user-facing name *is* the discriminant.

### Test Provider

The `test` provider is for the test suite only and is not in the user-facing `providers` map. Selection: if `WRAP_TEST_RESPONSE` is set (today's mechanism), `resolveProvider` short-circuits and returns a sentinel that `initProvider` routes to the test provider — config is not consulted at all.

This removes the `test` exception from the schema, the per-entry validation, and the wizard. Tests no longer need a `{ "providers": { "test": {} } }` block — setting the env var alone selects the test provider.

---

## Errors

**Config-resolution failure** — single generic message when no LLM can be resolved from the file/env state (any of: `providers` missing/empty, `defaultProvider` unset, `defaultProvider` not in `providers`, resolved entry has no `model`):

```
Config error: no LLM configured. Edit ~/.wrap/config.jsonc.
```

Single message is deliberate — the wizard (out of scope) will diagnose causes interactively.

**Per-entry validation** (config-time, surfaced before resolution):

- Unknown provider name with `baseURL`, `apiKey`, or `model` missing → `Config error: provider "xyz" requires baseURL, apiKey, and model.`
- `ollama` entry with no `baseURL` → `Config error: provider "ollama" requires baseURL.`

**Override-flag failures** (CLI/env path, distinct from config-failure):

- `--model` value naming a provider not in the merged providers map → `Config error: provider "xyz" not found in config.`
- `--model` empty value → `Config error: --model value is empty.`
- `--model anthropic` (or any provider override) where the resolved entry has no `model` → `Config error: provider "anthropic" has no model set in config.` (Distinct from the generic config error because the user used a flag — pointing them at the file is misdirection.)
- `--model` smart-resolution match against multiple providers' configured models → `Config error: model "X" is configured for multiple providers; use provider:model.`

Duplicate keys inside `providers` (legal in JSONC) resolve via jsonc-parser's last-wins rule. Not flagged as an error.

---

## JSON Schema

Loose validation. The schema documents top-level shape and the `ProviderEntry` shape, but does not enumerate known provider names — the runtime registry is the source of truth.

```jsonc
{
  "providers": {
    "type": "object",
    "additionalProperties": {
      "type": "object",
      "properties": {
        "apiKey":  { "type": "string" },
        "baseURL": { "type": "string" },
        "model":   { "type": "string" }
      },
      "additionalProperties": false
    }
  },
  "defaultProvider": { "type": "string" }
}
```

The old `oneOf` provider variants are removed. Per-provider field requirements (e.g. `ollama` needs `baseURL`, every entry needs `model`) are enforced at runtime, not in the schema, because they depend on the runtime provider registry.

---

## Logging

Two verbose log lines change in `src/main.ts`:

```
Config loaded (anthropic / claude-haiku-4-5)
Provider initialized (anthropic / claude-haiku-4-5)
```

Both show the resolved tuple (provider name + model), reflecting any override. No separate "overridden" indicator. The existing `providerLabel()` helper in `src/llm/types.ts` is replaced by formatting the `ResolvedProvider` directly.

---

## Out of Scope

- **Configuration wizard.** First-run UX, model listing via `/v1/models`, "recommended" model selection. Tracked separately. Wizard will be the supported path for editing config; this spec only ensures the file shape supports it.
- **`--config` subcommand family.** Listing/setting/getting config from CLI. Future addition.
- **Ad-hoc credential override flags.** No `--api-key` / `--base-url`.
- **Migration from old `provider` shape.** Pre-1.0; users restart.
