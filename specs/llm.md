# LLM Integration

> Architecture for Wrap's LLM provider system: provider-agnostic interface, provider taxonomy, multi-provider config, resolution, AI SDK integration, prompt scaffold assembly, structured output handling, and round retry.

> **Status:** Implemented

---

## Provider Interface

All providers implement a single `runPrompt(input, schema?)` method. Without a Zod schema → plain text (used by memory init). With a schema → validated, typed object (used by the command/reply flow).

`runCommandPrompt` (`src/llm/index.ts`) is a thin convenience that calls `provider.runPrompt(input, CommandResponseSchema)`. Schema-awareness stays outside the provider: providers don't know about Wrap's command response format.

**`PromptInput`** separates `system: string` from `messages: ConversationMessage[]`:

- **System**: exactly one string. Maps directly to the AI SDK's `generateText({ system, messages })`. CLI providers (claude-code) pass it via `--system-prompt`.
- **Messages**: pure user/assistant turns. Used for few-shot examples, separator, context, user query, round retry turns, thread continuation.

**Why a single method with optional schema** (not overloaded signatures): TypeScript struggles with overloads on object-literal implementations. One signature keeps every provider implementable as a plain object.

### Registry rationale

Provider **taxonomy** lives in `src/llm/providers/registry.ts` — the single source of truth. `API_PROVIDERS` and `CLI_PROVIDERS` carry both runtime metadata (`kind`, optional `validate`) and wizard metadata (`displayName`, `apiKeyUrl`, etc.). `getRegistration(name)` falls through both maps. `kind` selects the runtime SDK family.

Static imports for all provider packages. Wrap is a run-once CLI — startup cost is negligible, and static imports keep `initProvider` synchronous.

---

## Provider Taxonomy

| Name          | Allowed fields                  | `kind`          | Dispatches to                          |
|---------------|---------------------------------|-----------------|----------------------------------------|
| `anthropic`   | `apiKey?`, `baseURL?`, `model`  | `anthropic`     | AI SDK anthropic factory               |
| `openai`      | `apiKey?`, `baseURL?`, `model`  | `openai-compat` | AI SDK openai factory                  |
| `ollama`      | `baseURL` *(required)*, `model` | `openai-compat` | AI SDK openai factory, placeholder key |
| `claude-code` | `model`                         | `claude-code`   | `claude` CLI subprocess                |
| *any other*   | `baseURL`, `apiKey`, `model` *(all required)* | `openai-compat` | AI SDK openai factory  |

Unknown provider names default to `openai-compat` so users can point Wrap at groq/together/fireworks/etc. without code changes. The user-facing name **is** the discriminant — there is no `type` field. The name → SDK mapping is invisible to users.

**Why unknown providers require `apiKey`.** Without one, the call would silently send a placeholder string against a real billed endpoint. Failing early is safer than a mystery auth error on a billed request.

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

- **`providers`** — map keyed by user-facing provider name. Each value is a `ProviderEntry` (`apiKey?`, `baseURL?`, `model?`). Allowed/required fields depend on the name (see taxonomy).
- **`defaultProvider`** — which entry to use when no override is set.

### Why a map (not a single `provider` block)

The original config had a single `provider` block. Switching providers meant rewriting it and losing the old API key. The map shape lets users:

1. Persist credentials for several providers at once.
2. Switch the persistent default provider/model.
3. Override provider/model for a single run without editing the file.

**Why model lives inside the provider entry.** A model is only meaningful paired with the provider that serves it. Co-locating them makes file-level drift structurally impossible — switching `defaultProvider` switches its model in lockstep. Wrap never picks a model; the user does, once per provider they configure. Runtime `--model` overrides can still pair a provider with a transient model the API rejects — handled at § Resolution.

### API key resolution (`resolveApiKey`)

- **Omitted** → `undefined`; the SDK falls back to its default env var (e.g. `ANTHROPIC_API_KEY`). Zero config for users with standard env vars.
- **`"$MY_KEY"`** → reads `process.env.MY_KEY`. Clear `Config error:` if unset.
- **Literal string** → used as-is. Same posture as any dotfile credential store.

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

### Architecture

Three layers:

1. **`ensureConfig`** (`src/config/ensure.ts`) — if `config.jsonc` exists, loads it via `loadConfig`; otherwise runs the wizard (see `config.md`). `loadConfig` in `src/config/config.ts` owns `Config` and `ProviderEntry` types; returns file ⊕ `WRAP_CONFIG`.
2. **`applyModelOverride`** (`src/config/resolve.ts`) — reads `--model`/`WRAP_MODEL` via SETTINGS, calls `parseModelOverride` to compute `{providerName, transientModel}`, then writes those into `config.defaultProvider` and `config.providers[name].model`. Throws on malformed overrides (empty, ambiguous, unknown built-in). After this step the config's own fields carry the user's intent — no separate override string floats around.
3. **`resolveProvider`** (`src/llm/resolve-provider.ts`) — pure: `(Config, env?) → ResolvedProvider`. Reads `defaultProvider` and the matching entry, runs per-entry validation via the registry, produces the final tuple. Short-circuits to the test sentinel when `WRAP_TEST_RESPONSE`/`WRAP_TEST_RESPONSES` is set.
4. **`initProvider`** (`src/llm/index.ts`) — dispatches `ResolvedProvider` to the right factory via the registry's `kind`.

```ts
type ResolvedProvider = {
  name:     string;   // 'anthropic', 'ollama', 'groq', …
  model:    string;
  apiKey?:  string;
  baseURL?: string;
};
```

`parseArgs` treats `--model`/`--provider` as value-taking modifiers (the `model` setting in SETTINGS). `main.ts` runs `applyModelOverride` between `resolveSettings` and `setConfig`, so by the time `resolveProvider` reads the store it's seeing the normalized config.

### Override parsing

`parseModelOverride(override, providers, defaultProvider) → {providerName, transientModel}` is the pure parse. Formats handled:

- `provider:model` — that provider, that model (transient, not written to disk)
- `provider` (configured key) — that provider's stored model
- `:model` — default provider, different model
- bare value — smart match: unique configured model, then known-provider diagnostic (error if built-in but not configured), then fall through to `defaultProvider` with the bare value as transient model

---

## Errors

**Config-resolution failure** — generic message when there's no signal to work with (`providers` missing/empty AND no `defaultProvider`):

```
Config error: no LLM configured. Edit ~/.wrap/config.jsonc.
```

Once `defaultProvider` is set (from file or from override normalization), errors become specific: `provider "X" not found in config.` / `provider "X" has no model set in config.` / per-entry validation messages. This is actionable — the user knows which thing is wrong.

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

## Provider Implementations

### AI SDK Provider (`src/llm/providers/ai-sdk.ts`)

Dispatches on `kind` to `createAnthropic` or `createOpenAI`, then calls `generateText` with `Output.object({ schema })` for structured output.

**OpenAI strict-schema gotcha.** OpenAI's strict mode requires every property to appear in `required`. Wrap's Zod schema uses `.nullable().optional()` for optional fields, which generates `anyOf: [type, null]` — but the fields still aren't added to `required`. `toOpenAIStrictSchema` walks the JSON schema tree (`properties`, `items`, `anyOf`/`oneOf`/`allOf`) and injects every property key into `required`. Applied to `openai-compat` only; the Anthropic factory passes the Zod schema straight through.

**Local endpoint placeholder key.** `@ai-sdk/openai` demands an API key even when `baseURL` points at a local model server (Ollama, LM Studio). When `baseURL` is set and no key is configured, Wrap injects the literal `"nokey"` so local models work without the user setting a dummy env var.

### Claude Code Provider (`src/llm/providers/claude-code.ts`)

Spawns `claude` CLI as a subprocess. Passes `--system-prompt` directly and **flattens** the messages array into a single `-p` string (`User: ...\n\nAssistant: ...`) because the CLI has no multi-turn input format. With a schema, passes `--json-schema` and strips code fences from the response before parsing.

Runs in `tmpdir()` to avoid leaking the user's cwd into Claude Code's own session discovery. `--no-session-persistence` prevents it from creating a session on disk. The `--bare` flag would skip MCP/config discovery (~10x faster) but also skips credential loading, so it's not usable until Claude Code fixes that.

### Test Provider (`src/llm/providers/test.ts`)

Deterministic mock driven by env vars:
- `WRAP_TEST_RESPONSE` → single canned response reused for every call.
- `WRAP_TEST_RESPONSES` → JSON array, one per call in order (throws if exhausted).
- Falls back to echoing the last user message if neither is set.
- A response starting with `ERROR:` throws. With a schema, the response is JSON-parsed and validated.

Selected by env presence, not by config — `resolveProvider` short-circuits to the `TEST_RESOLVED_PROVIDER` sentinel; `initProvider` routes that sentinel to `testProvider()`. Config is not consulted at all, so tests don't need a providers block. The `test` provider is not user-facing and not in the providers map.

### Provider Dispatch (`src/llm/index.ts`)

`initProvider(resolved)` takes a `ResolvedProvider`, special-cases the `test` sentinel, and otherwise switches on `getRegistration(name).kind` to pick a factory.

---

## Prompt Scaffold Assembly (`src/llm/context.ts`)

The per-session **prompt scaffold** is built **once** at session start, not per round. `assemblePromptScaffold(ctx)` returns a `PromptScaffold`:

```
{ system, prefixMessages, initialUserText }
```

- **`system`**: concatenated instruction blocks (static, cacheable).
- **`prefixMessages`**: few-shot example turn pairs + separator, prepended verbatim to every round's messages array.
- **`initialUserText`**: the context string + user query, pushed to the transcript as the first user turn.

The runner combines these with the evolving transcript on each round via `buildPromptInput` to produce a fresh `PromptInput`. The scaffold itself is immutable.

It delegates to two pure functions:

- **`formatContext()`** (`src/llm/format-context.ts`) — memory (filtered by cwd prefix, sectioned by scope), tools, cwd files, cwd, piped-input flag → a single context string.
- **`buildPromptScaffold()`** (`src/llm/build-prompt.ts`) — assembles `system` + `prefixMessages` + `initialUserText` from prompt config, context string, and query.

### System prompt composition

`instruction` + `memoryRecencyInstruction` + `toolsScopeInstruction` + `voiceInstructions` + (optional) `pipedInputInstruction` + (if schema present) `schemaInstruction` + `schemaText`. All joined with blank lines.

### Message ordering (cache-friendly)

1. **Few-shot examples** as user/assistant pairs (static, cacheable across runs).
2. **Separator** (`fewShotSeparator`, e.g. "Now handle the following request.") as a final user turn in `prefixMessages`. Marks the boundary so the LLM doesn't treat real conversation as more examples.
3. **Initial user turn** (`initialUserText`): context string + `sectionUserRequest` + query. Pushed to the transcript by the session at startup.
4. **Subsequent round turns** appended by the loop.

**Why memory and cwd go in the user turn, not the system prompt.** They're dynamic per-request. Keeping them out of `system` makes the system-prompt + few-shot prefix fully static and eligible for provider-side prompt caching.

### Prompt data files

Two shared JSON files are the source of truth:

- **`src/prompt.constants.json`** — static strings (section headers, separators, behavioral instructions). Committed, hand-edited.
- **`src/prompt.optimized.json`** — optimizer output (instruction, demos, schema text, prompt hash). Written by `bun run optimize`. See `eval/specs/eval.md`.

**Before editing any prompt text, read `.claude/skills/editing-prompts.md`** — the prompt exists as a Python source of truth (for the DSPy optimizer) plus a TS runtime mirror, and editing the wrong one silently breaks the optimizer.

---

## Round Retry

When a round's LLM call throws a **structured-output error** (invalid JSON, schema mismatch, `NoObjectGeneratedError`), the round is retried **once**. The retry appends the failed raw text as an assistant turn plus `jsonRetryInstruction` as a user turn, so the model can self-correct.

Lives in `src/core/round.ts` as `callWithRetry` — provider-agnostic. Detection is in `isStructuredOutputError` (AI SDK's `NoObjectGeneratedError.isInstance` plus string-match fallbacks for providers that throw plain `Error`s). The failed text is extracted via `NoObjectGeneratedError.text` when available.

Messages are **not mutated** — the retry builds a fresh array. This matters because `callWithRetry` runs inside the round loop and the caller's `input.messages` is reused across rounds.

---

## Extending

**Adding a new built-in provider** = one entry in `API_PROVIDERS` or `CLI_PROVIDERS`. **Adding a brand-new SDK family** = new `kind` + new branch in `initProvider` + new factory file — all obvious.

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

---

## Open Questions

1. **Schema text in system prompt.** For API providers with native structured output, the embedded schema text is redundant, but it helps the LLM understand field semantics. Always included for now.
2. **Few-shot + structured output.** Few-shot assistant turns contain raw JSON. Verify this plays well with `Output.object()`; fallback would be to move few-shot into the system prompt.
3. **Separator message.** The "Now handle the following request." turn is a prompt-engineering hypothesis. Validate via eval.
