# Multi-Provider Config

> `config.jsonc` carries a `providers` map plus a `defaultProvider`. Users keep credentials for several LLM providers side by side and switch the default without losing the others.

> **Status:** Implemented.

---

## Why

The original config had a single `provider` block. Switching providers meant rewriting it and losing the old API key. The map shape lets users:

1. Persist credentials for several providers at once.
2. Switch the persistent default provider/model.
3. Override provider/model for a single run without editing the file.

**Why model lives inside the provider entry.** A model is only meaningful paired with the provider that serves it. Co-locating them makes file-level drift structurally impossible — switching `defaultProvider` switches its model in lockstep. Wrap never picks a model; the user does, once per provider they configure. Runtime `--model` overrides can still pair a provider with a transient model the API rejects — handled at § Resolution.

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

- **`providers`** — map keyed by user-facing provider name. Each value is a `ProviderEntry` (`apiKey?`, `baseURL?`, `model?`). Allowed/required fields depend on the name (see registry).
- **`defaultProvider`** — which entry to use when no override is set.

`apiKey` resolution (`$VAR`, omitted, literal) is shared with `specs/llm-sdk.md` § AI SDK Provider.

---

## Provider Taxonomy

`src/llm/providers/registry.ts` is the single source of truth. `KNOWN_PROVIDERS` maps name → `{ kind, validate? }`. `kind` selects the runtime SDK family; unknown names default to `openai-compat`.

| Name          | Allowed fields                  | `kind`          | Dispatches to                          |
|---------------|---------------------------------|-----------------|----------------------------------------|
| `anthropic`   | `apiKey?`, `baseURL?`, `model`  | `anthropic`     | AI SDK anthropic factory               |
| `openai`      | `apiKey?`, `baseURL?`, `model`  | `openai-compat` | AI SDK openai factory                  |
| `ollama`      | `baseURL` *(required)*, `model` | `openai-compat` | AI SDK openai factory, placeholder key |
| `claude-code` | `model`                         | `claude-code`   | `claude` CLI subprocess                |
| *any other*   | `baseURL`, `apiKey`, `model` *(all required)* | `openai-compat` | AI SDK openai factory  |

The user-facing name **is** the discriminant — there is no `type` field. The name → SDK mapping is invisible to users.

**Why unknown providers require `apiKey`.** Without one, the call would silently send a placeholder string against a real billed endpoint. Failing early is safer than a mystery auth error on a billed request.

**Adding a built-in** = one entry in `KNOWN_PROVIDERS`. **Adding a new SDK family** = a new `kind`, a new branch in `initProvider`, a new factory file — all obvious.

### Test provider

The `test` provider is not user-facing and not in the providers map. `resolveProvider` short-circuits on `WRAP_TEST_RESPONSE` / `WRAP_TEST_RESPONSES` and returns `TEST_RESOLVED_PROVIDER`; `initProvider` routes that sentinel to `testProvider()`. Config is not consulted at all, so tests don't need a providers block.

---

## Resolution

Layered precedence (lowest → highest):

1. `config.jsonc` in `WRAP_HOME`
2. `WRAP_CONFIG` env var — **top-level shallow merge** over file
3. `WRAP_MODEL` env var — overrides provider and/or model for one run
4. `--model` / `--provider` CLI flag — same semantics, wins over env

### Shallow-merge gotcha

Nested objects are replaced wholesale, not deep-merged:

```
file:        providers={anthropic:{...}, openai:{...}}, defaultProvider=anthropic
WRAP_CONFIG: {"providers":{"openai":{"apiKey":"$NEW","model":"gpt-4o"}}}
result:      providers={openai:{apiKey:"$NEW",model:"gpt-4o"}}  ← anthropic is GONE
```

This is deliberate: a single, consistent merge rule across all top-level keys beats a special case for `providers`. To tweak just the active provider/model without redefining the map, use `WRAP_MODEL` or `--model`.

### Override value parsing

`--provider` is an alias for `--model`. Both flags and `WRAP_MODEL` share one parser. `--model` is canonical because the smart-resolution path most often receives a model name; `--provider` reads better when the value is a provider name.

"Transient" model = used for this run only, not written back.

```
--model anthropic:claude-opus-4-5   → anthropic, transient model claude-opus-4-5
--model anthropic                   → anthropic, with anthropic.model from config
--model :claude-opus-4-5            → defaultProvider, transient claude-opus-4-5
--model claude-opus-4-5             → smart: matches anthropic.model in config → anthropic
--model gpt-9999                    → smart: no match → defaultProvider with transient
```

Rules:
- Split on the **first** `:` only (`openai:gpt-4o:turbo` → `openai` / `gpt-4o:turbo`).
- Empty or bare `:` → `Config error: --model value is empty.`
- No `:` → smart resolution in order:
  1. Match against merged `providers` keys → provider override (use that entry's stored model).
  2. Match against `providers[*].model` values → if exactly one hit, use that entry. Multiple hits → error: `model "X" is configured for multiple providers; use provider:model.`
  3. No match → model override on `defaultProvider` (transient).
- Naming a **known built-in** that is **not configured** (`--model openai` with no openai entry) → `provider "openai" not found in config.` Smart resolution only looks at *configured* names, never built-in names.

Smart resolution is purely local — it never queries any provider's API. It always runs against the **merged** map (file ⊕ `WRAP_CONFIG`); the override layer never sees the raw file map.

### Override scope

Overrides swap *which* entry is used and optionally *which* model. `apiKey` and `baseURL` always come from the resolved entry. There is no flag for ad-hoc credentials — edit config or set env vars. Omitted `apiKey` on a known provider still falls back to the SDK's default env var (e.g. `ANTHROPIC_API_KEY`) whether the entry was reached via `defaultProvider` or via override.

A transient model the resolved provider's API rejects is passed through to the SDK. The SDK's error is wrapped with a Wrap-prefixed message so users never see raw SDK chrome on stderr.

---

## Architecture

Two layers with a pure resolver between:

1. **`loadConfig`** (`src/config/config.ts`) — owns `Config` and `ProviderEntry` types; returns file ⊕ `WRAP_CONFIG`.
2. **`resolveProvider`** (`src/llm/resolve-provider.ts`) — pure: `(Config, override, env) → ResolvedProvider`. Parses the override, applies smart resolution, runs per-entry validation via the registry, produces the final tuple.
3. **`initProvider`** (`src/llm/index.ts`) — dispatches `ResolvedProvider` to the right factory via the registry's `kind`.

```ts
type ResolvedProvider = {
  name:     string;   // 'anthropic', 'ollama', 'groq', …
  model:    string;
  apiKey?:  string;
  baseURL?: string;
};
```

`parseArgs` in `src/core/input.ts` treats `--model`/`--provider` as value-taking modifiers. `main.ts` picks `modifiers.values.get("modelOverride") ?? process.env.WRAP_MODEL` and hands it to `resolveProvider`.

---

## Errors

**Config-resolution failure** — single generic message when no LLM can be resolved (any of: `providers` missing/empty, `defaultProvider` unset or not in map, resolved entry has no `model`):

```
Config error: no LLM configured. Edit ~/.wrap/config.jsonc.
```

One message is deliberate: the config wizard (out of scope) will diagnose causes interactively.

**Per-entry validation** (runs before the no-model check so a structurally invalid entry reports the actionable error):

- Unknown provider name missing `baseURL`/`apiKey`/`model` → `provider "xyz" requires baseURL, apiKey, and model.`
- `ollama` without `baseURL` → `provider "ollama" requires baseURL.`

**Override-path errors** (distinct from the generic one — when the user used a flag, pointing them at the file is misdirection):

- `--model` names a provider not in the merged map → `provider "xyz" not found in config.`
- `--model` empty → `--model value is empty.`
- `--model anthropic` where the resolved entry has no `model` → `provider "anthropic" has no model set in config.`
- `--model` smart match hits multiple providers' models → `model "X" is configured for multiple providers; use provider:model.`

Duplicate keys inside `providers` are legal in JSONC; jsonc-parser resolves last-wins. Not flagged.

---

## JSON Schema

Loose. `config.schema.json` documents the top-level shape and `ProviderEntry` shape but does **not** enumerate known provider names — the runtime registry is the source of truth. Per-provider field requirements (`ollama` needs `baseURL`, unknown providers need all three) are enforced at runtime, not in the schema, because they depend on the registry.

The old `oneOf` provider variants are gone.

---

## Logging

Two verbose lines in `src/main.ts`:

```
Config loaded (anthropic / claude-haiku-4-5)
Provider initialized (anthropic / claude-haiku-4-5)
```

Both show the resolved tuple — any override is already baked in, so there is no separate "overridden" indicator. `formatProvider()` in `src/llm/types.ts` produces the label.

---

## Out of Scope

- **Config wizard.** First-run UX, `/v1/models` listing, recommended-model picks. Will be the supported path for editing config; this spec only ensures the shape supports it.
- **`--config` subcommand family.** Listing/setting/getting config from CLI.
- **Ad-hoc credential override flags.** No `--api-key` / `--base-url`.
- **Migration from old `provider` shape.** Pre-1.0; users restart.
