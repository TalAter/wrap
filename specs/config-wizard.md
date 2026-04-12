# Config Wizard

Interactive TUI that runs on first launch to write a valid `~/.wrap/config.jsonc`. Replaces the current generic `Config error: no LLM configured` dead-end for new users.

## Triggers

- **First-run** — `~/.wrap/config.jsonc` is missing. `ensureConfig()` detects this and launches the wizard before any LLM code path runs. After the wizard saves, execution continues with the user's original query (`w find big files` runs their query once config is written).

## Scope

**In scope:** provider selection, API key entry, model selection, writing a fresh `config.jsonc` with `$schema` + `providers` + `defaultProvider`.

**Out of scope for v1:**
- **`w --config` / `w --init` flags** — first-run only. Re-running the wizard over an existing config needs preselect-from-current-state semantics to avoid footgun behavior. See [Future work](#future-work-explicitly-deferred). v1 users who want to change their config hand-edit `config.jsonc`.
- **Alias setup** — separate spec.
- **"More providers…" picker** and any freeform "Custom provider" entry — v1 is the curated shortlist + detected `claude-code` only. Users who need non-shortlist providers hand-edit `config.jsonc`.
- **Editing advanced fields** (`maxRounds`, `verbose`, `maxCapturedOutputChars`, `maxPipedInputChars`) — users edit `config.jsonc` directly.
- **API key validation** — the wizard never calls the provider API. Invalid keys fail at first real use.
- **Env-var detection + Tab-to-fill.** Nice-to-have that lets users who have `$ANTHROPIC_API_KEY` already set in their shell skip the paste. Defer — paste flow works for everyone for v1.

## Integration

Add `ensureConfig()` in `src/config/config.ts` (or a new `src/config/ensure.ts`). It calls `loadConfig()` internally: if the file exists and parses, returns the loaded config; otherwise runs the wizard, writes the file, loads the config, and returns it. `main.ts` calls `ensureConfig()` instead of `loadConfig()`. No other main-flow changes.

On user cancel (Esc / Ctrl+C from the wizard), `ensureConfig()` calls `process.exit(0)` directly — there's no sensible config to return, and the user's original query is abandoned. This keeps the return type unconditionally `Config` for callers.

## Component vocabulary

Three TUI components, introduced here so the rest of the spec can reference them:

- **`Dialog`** (new, `src/tui/dialog.tsx`) — the generic bordered-chrome component. Top border with optional badge, gradient side bars, bottom border with optional status text, centers on the terminal, knows nothing about what's inside. Both specific dialogs below render their content inside a `<Dialog>`.
- **`ResponseDialog`** (`src/tui/response-dialog.tsx`) — the existing command-response confirmation component, currently named `Dialog` in `src/tui/dialog.tsx`. Renamed as part of the extraction. Knows about commands, risk levels, explanations, plans, the output slot, and the action bar. Tightly coupled to `AppState`.
- **`ConfigWizardDialog`** (`src/tui/config-wizard-dialog.tsx`) — the new wizard component. Multi-screen state machine (provider selection → per-provider loop → default picker). Renders inside `<Dialog>` with wizard-specific gradient stops and badge.

A "dialog" in Wrap's vocabulary is any bordered panel that presents data or collects a decision. The generic `Dialog` component is the shared chrome; `ResponseDialog` and `ConfigWizardDialog` are two specific flavors that wrap their content inside it. Concrete props and extraction mechanics are in [TUI implementation notes](#tui-implementation-notes).

## Provider data sources

### API Providers

Two sources, merged at runtime:

1. **Curated shortlist** — hardcoded. Priority order, API-key URLs, placeholders, recommendation regexes. See [Curated shortlist](#curated-shortlist). The hardcoded providers get extra data (eg latest models) from:
2. **https://models.dev/api.json** — fetched and cached; provides the model list per provider, plus optional metadata (`env[]`, `doc`, `api`, `limit.context`, `cost`, `release_date`, `tool_call`, `modalities`, `status`). See [models.dev integration](#modelsdev-integration).

### CLI Providers

CLI tool providers (v1: only `claude-code`) come from `CLI_PROVIDERS` — detected at wizard launch via `Bun.which(probeCmd)`.

## Curated shortlist

Two hardcoded maps both live in `src/llm/providers/registry.ts`, keyed by provider id. Each map has its own type — API providers carry API-key metadata, CLI providers carry `probeCmd`.

```ts
// src/llm/providers/registry.ts

export type ApiProvider = {
  displayName: string;
  kind: ProviderKind;
  validate?: (entry: ProviderEntry) => string | null;
  apiKeyUrl?: string;
  apiKeyPlaceholder?: string;
  // Prefilled when models.dev has no `api` field for this provider (e.g. ollama).
  baseURL?: string;
  recommendedModelRegex?: RegExp;
};

export type CliProvider = {
  displayName: string;
  kind: ProviderKind;
  probeCmd: string;
};

export const API_PROVIDERS: Record<string, ApiProvider> = {
  anthropic: {
    displayName: "Anthropic",
    kind: "anthropic",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "sk-ant-api03-",
    recommendedModelRegex: /^claude-sonnet-\d+-\d+$/,
  },
  openai: {
    displayName: "OpenAI",
    kind: "openai-compat",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-proj-",
    recommendedModelRegex: /^gpt-5(\.\d+)?$/,
  },
  // TODO: enable once @ai-sdk/google is bundled and a `kind: "google"` branch
  // lands in this file + ai-sdk.ts. See Future work.
  // google: {
  //   displayName: "Google (Gemini)",
  //   kind: "google",
  //   apiKeyUrl: "https://aistudio.google.com/apikey",
  //   recommendedModelRegex: /^gemini-\d+(\.\d+)?-pro$/,
  // },
  openrouter: {
    displayName: "OpenRouter",
    kind: "openai-compat",
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyPlaceholder: "sk-or-v1-",
    baseURL: "https://openrouter.ai/api/v1",
  },
  groq: {
    displayName: "Groq",
    kind: "openai-compat",
    apiKeyUrl: "https://console.groq.com/keys",
    apiKeyPlaceholder: "gsk_",
  },
  mistral: {
    displayName: "Mistral",
    kind: "openai-compat",
    apiKeyUrl: "https://console.mistral.ai/api-keys",
  },
  ollama: {
    displayName: "Ollama (local)",
    kind: "openai-compat",
    baseURL: "http://localhost:11434/v1",
    validate: (entry) =>
      entry.baseURL ? null : 'Config error: provider "ollama" requires baseURL.',
  },
};

export const CLI_PROVIDERS: Record<string, CliProvider> = {
  "claude-code": {
    displayName: "Claude Code",
    kind: "claude-code",
    probeCmd: "claude",
  },
};

// Runtime lookup. Falls through both maps, then defaults to openai-compat
// for unknown ids. Replaces the old flat KNOWN_PROVIDERS map; call sites
// in the rest of the codebase stay the same.
export function getRegistration(name: string): ProviderRegistration {
  const api = API_PROVIDERS[name];
  if (api) return { kind: api.kind, validate: api.validate };
  const cli = CLI_PROVIDERS[name];
  if (cli) return { kind: cli.kind };
  return { kind: "openai-compat" };
}

// Existing — unchanged signature; delegates to getRegistration internally.
export function validateProviderEntry(name: string, entry: ProviderEntry): string | null;
```

`Record<string, T>` object-literal key order is stable in modern JS/TS, so the declared order of `API_PROVIDERS` doubles as the display order on Screen 1.

### Routing per shortlist provider

Verified against the AI SDK docs:

- **Anthropic, OpenAI, Ollama, OpenRouter, Groq, Mistral** — all work through existing code paths. OpenRouter/Groq/Mistral route via the existing `openai-compat` kind with a custom `baseURL`, full `response_format: json_schema` strict mode support.
- **Google (Gemini)** — commented out in v1. Its OpenAI-compat endpoint has incomplete structured-output support, so enabling it requires `@ai-sdk/google` and a new `kind: "google"` branch in `src/llm/providers/registry.ts` + factory wiring in `src/llm/providers/ai-sdk.ts`. Tracked in Future work.
- **DeepSeek** — OpenAI-compatible but only supports `json_object`, not `json_schema`. Wrap's `Output.object({ schema })` path needs strict JSON schema, so DeepSeek is **not usable with Wrap today** and is deliberately absent from `API_PROVIDERS`. Revisit if DeepSeek adds strict mode.

## models.dev integration

### Fetch & cache

- **URL:** `https://models.dev/api.json` (~1.7MB, 110 providers, ~4168 models).
- **Cache path:** `~/.wrap/cache/models.dev.json` (new `cache/` subdir under `$WRAP_HOME`).
- **TTL:** 24h. Fresh cache is used as-is; otherwise refetch.
- **Generic cache helper.** Introduce a new module `src/core/cache.ts` with a small API used here but reusable elsewhere:

  ```ts
  export async function fetchCached(opts: {
    url: string;
    // Relative to $WRAP_HOME/cache/ — e.g. "models.dev.json".
    path: string;
    ttlMs: number;
  }): Promise<{ stale: boolean; content: string }>;
  ```

  Semantics:
  - If `cache/<path>` exists and `mtime + ttlMs > now`: return `{ stale: false, content }` without hitting the network.
  - Otherwise, fetch `url`. On success, write via `writeWrapFile(\`cache/${path}\`, ...)` (the wrap-home IO helper creates the directory on demand) and return `{ stale: false, content }`.
  - If the fetch fails AND the cache file exists: return `{ stale: true, content }`. Caller decides whether to use it.
  - If the fetch fails AND there is no cache file: throw.

  `stale` is named from the caller's perspective: `true` means "the network call failed and I'm serving you the last known copy." Wizard uses it to log via `verbose()` but otherwise treats the content as usable.

### Fetch timing

Synchronous between Screen 1 (provider selection) and Screen 2 (per-provider loop). After the user submits Screen 1, the wizard transitions to the `loading-models` screen state while `fetchCached` resolves. The `Loading models list…` status is rendered on the **bottom border** via `Dialog`'s existing `bottomStatus` prop (same mechanism `ResponseDialog` uses for its "Reticulating splines..." followup status) — no new prop needed. On cache hit (the common case after first run) the spinner flashes for a few ms; on cache miss it's the network round-trip.

### Offline / fetch failure

If `fetchCached` throws (no network and no cache on first run), abort with `Config error: could not load model list from https://models.dev/api.json. Check your connection and try again.` Exits 1. Next run retries. Acceptable first-run cost — users installing Wrap have just pulled a binary from the network, so network availability is a safe first-run precondition. A bundled snapshot is tracked in [Future work](#future-work-explicitly-deferred) if offline first-run becomes a real pain point.

### Model filter

Applied to the models list returned for a provider before display:

1. `modalities.input` includes `"text"` and `modalities.output` includes `"text"`.
2. `status !== "deprecated"`.
3. `tool_call === true`. *(Wrap uses structured JSON output, not tool calling, but `tool_call: true` is a reliable "modern chat model" proxy in models.dev since `structured_output` is under-reported. Revisit if this hides legitimately-working models.)*

Sort the filtered list by `release_date` descending (newest first).

### Recommendation

If the provider's `recommendedModelRegex` matches any model in the filtered list, pick the **newest matching** model (highest `release_date` among matches), move only that one to the top of the list, and mark only it with a `✦` (U+2726, BLACK FOUR POINTED STAR — renders reliably in monospace, visually distinct from asterisk). Other matching models stay in their `release_date`-sorted positions with no marker. If the regex matches nothing (or no regex is defined), don't mark anything — the list is just `release_date`-sorted and the user picks manually. The first row is pre-highlighted either way.

## Screen flow

Four screens, linear, no back navigation. Rendered to stderr via Ink (same pattern as `src/session/dialog-host.ts` → `preloadDialogModules`). `ConfigWizardDialog` lives in `src/tui/config-wizard-dialog.tsx` as its own component tree but renders inside the shared `<Dialog>` and reuses `TextInput`, border styling, and the preload plumbing.

### Screen 1 — Provider selection

Multi-select checklist, two groups with headers.

```
┌─────────────────────────────────┐
│ Select providers:               │
│                                 │
│  API Providers                  │
│   [x] Anthropic                 │
│   [ ] OpenAI                    │
│   [ ] OpenRouter                │
│   [ ] Groq                      │
│   [ ] Mistral                   │
│   [ ] Ollama (local)            │
│                                 │
│  CLI Tools                      │
│   [ ] Claude Code               │
│                                 │
│    Space to select │ ⏎ to send  │
└─────────────────────────────────┘
```

- **Keys:** `↑`/`↓` move, `Space` toggles, `Enter` submits. `Esc` / `Ctrl+C` abort.
- **CLI tools section** only appears if at least one `which` probe succeeds. Individual CLI providers whose binary isn't resolved by `which` render as greyed-out and unselectable, labeled `(not installed)`. For v1, only `claude-code` exists in `CLI_PROVIDERS`, so the section is hidden entirely if `which claude` doesn't resolve.
- **Footer hint:** `Space to select │ ⏎ to send` — but the `⏎ to send` half is hidden while zero checkboxes are ticked, and `Enter` is a no-op in that state. Prevents the empty-selection error case entirely.
- **Ordering:** `API_PROVIDERS` in the declared priority order, then `CLI_PROVIDERS`. No "detected-first" reordering — the order is stable across runs.

### Screen 2 — Per-provider loop

For each selected provider in `API_PROVIDERS` order (then any selected CLI providers), run the sub-screens back to back.

#### 2a — API key

Skipped entirely for providers without an `apiKeyUrl` (Ollama) and for `claude-code` (see Screen 2c).

```
┌─────────────────────────────────┐
│ Anthropic API key               │
│ Get one: https://console...     │
│                                 │
│ [sk-ant-api03-_______________]  │
│                                 │
│   ⏎ to continue                 │
└─────────────────────────────────┘
```

- **Input:** `TextInput` in masked mode (new prop — renders `•` for every non-placeholder char). Placeholder comes from `apiKeyPlaceholder`; if missing, no placeholder.
- **Submit:** Enter submits. Trim leading/trailing whitespace on submit (users paste keys with trailing newlines). Empty submission does nothing. The literal key is written as `apiKey: "<literal>"` into config.jsonc.
- **Paste:** standard Ink `useInput` character delivery. Ink delivers pasted strings as a single multi-char `input` to `useInput`, and `Cursor.insert()` handles multi-char inserts already.

#### 2b — Model selection

```
┌─────────────────────────────────┐
│ Anthropic model                 │
│                                 │
│  ▶ claude-sonnet-4-6         ✦  │
│    claude-opus-4-6              │
│    claude-haiku-4-5             │
│    claude-sonnet-4-5            │
│    ...                          │
│                                 │
│   ↑↓ to move │ ⏎ to continue    │
└─────────────────────────────────┘
```

- Single-select with viewport scrolling. Arrow keys move, Enter confirms.
- `✦` marks the regex-recommended model if one exists; it's placed at row 0 regardless of its `release_date` rank. The rest of the list stays sorted by `release_date` desc.
- First row is pre-highlighted. Pressing Enter immediately on the provider-selection screen and accepting defaults all the way through yields a working config with the newest recommended model.
- Filtered list being empty for a curated provider shouldn't happen. If it does, it's a bug — let it throw into the top-level error handler rather than specifying a fallback UI.

#### 2c — Claude Code (no key, no model)

For any provider in `CLI_PROVIDERS` (v1: only `claude-code`):
- **No API key step** (2a skipped) — the CLI owns its own credentials.
- **No model step** (2b skipped). The wizard writes the provider entry with no `model` field; the CLI picks its own default at runtime. CLI tools don't expose a reliable "list my models" command and their valid IDs change between versions — letting the CLI own the choice keeps Wrap out of that maintenance loop. Users who want a specific model hand-edit `config.jsonc`. (This is why Implementation order step 5 patches `resolveProvider` to allow claude-code entries to have no `model` — without the fix, the wizard's own output would fail to resolve.)
- Before writing: display the **CLI terms-of-service disclaimer** inline as a blocking full-screen message:

  ```
  Wrap will route your queries through the `claude` CLI instead
  of calling the Anthropic API directly. This is slower, and your
  prompts flow through Claude Code under its own terms — bring
  your own subscription and credentials.

   ⏎ to accept │ Esc to skip this provider
  ```

  Pressing Enter accepts. Pressing Esc drops claude-code from the selection and continues the loop with any remaining providers. If claude-code was the *only* selection, dropping it would leave zero providers configured — in that case, Esc bounces the user back to Screen 1 (provider selection) instead of exiting, so they can pick something else.

### Screen 3 — Default provider

Skipped if exactly one provider was configured. Otherwise:

```
┌─────────────────────────────────┐
│ Which provider should be the    │
│ default?                        │
│                                 │
│  ▶ anthropic                    │
│    openai                       │
│    ollama                       │
│                                 │
│   ↑↓ to move │ ⏎ to select      │
└─────────────────────────────────┘
```

- List is the providers that were just configured.
- `defaultProvider` is required — no skip option. The chosen value is written verbatim.

### Screen 4 — Done

No screen. The wizard unmounts cleanly (same teardown as the dialog), writes config, then calls `chrome("Configuration saved", "🧠")` from `src/core/output.ts` (the helper prepends the icon — do not bake it into the text). Control returns to `ensureConfig()`.

## Write semantics

### Filesystem preconditions

On a fresh install, `~/.wrap/` does not exist and the wizard is the first thing to write to it. Today the codebase is inconsistent — two write sites create the dir inline, one doesn't and would crash. This spec fixes that by introducing a shared wrap-home IO helper that every module uses.

#### Shared wrap-home IO helper

New module `src/core/wrap-home-dir.ts`:

```ts
// All three resolve the base path via getWrapHome(); writes create parent dirs.
export function readWrapFile(relPath: string): string | null;
export function writeWrapFile(relPath: string, content: string | Buffer): void;
export function appendWrapFile(relPath: string, content: string | Buffer): void;
```

Migrate the existing `~/.wrap/` I/O sites to these helpers in the same PR: `memory.ts`, `logging/writer.ts`, `discovery/watchlist.ts` (fixes the missing-parent crash as a side effect), and the `existsSync`-gated reads in `loadWatchlist`/`loadMemory`/`loadFileConfig`. Listed file paths and line numbers go in the PR description, not here.

#### What the wizard needs

The wizard writes three files, all via `writeWrapFile`:

1. **`config.jsonc`** — the serialized config.
2. **`config.schema.json`** — a copy of `src/config/config.schema.json` so the `"$schema": "./config.schema.json"` reference resolves for users' editors. Overwritten on every successful config write to stay in sync with the installed Wrap version. Bundled via static JSON import (`import schema from "../config/config.schema.json" with { type: "json" }`) — `Bun.file` on a path won't survive `bun build --compile`.
3. **`cache/models.dev.json`** — written indirectly by `fetchCached` (see [Generic cache helper](#generic-cache-helper)). The wizard never touches the cache directory itself.

### First run

v1 is first-run only — `~/.wrap/config.jsonc` does not exist and the wizard writes it fresh via `JSON.stringify(..., null, 2)` through `writeWrapFile("config.jsonc", ...)`. Three top-level keys: `$schema` (pointing at `./config.schema.json` for editor support), `providers` (exactly what the wizard configured), and `defaultProvider` (the chosen one). Advanced fields are not written.

**Pre-write validation.** Before serializing, run each accumulated entry through `validateProviderEntry(name, entry)` from `src/llm/providers/registry.ts`. Any returned error propagates to the top-level `main.ts` catch (same path as other `Config error:` messages). Cheap insurance against wizard logic bugs producing a config that would immediately fail `resolveProvider`.

### Config file format after a minimal first run

```jsonc
{
  "$schema": "./config.schema.json",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-api03-gvlJ...",
      "model": "claude-sonnet-4-6"
    }
  },
  "defaultProvider": "anthropic"
}
```

When the provider needs a `baseURL` (Ollama, OpenRouter), it's written as a third field.

## Cancellation

- **Esc / Ctrl+C at any screen:** abort. No file written. No partial save. Any query the user passed on the command line is dropped with a silent exit (no error — the wizard cleanly unmounted). The next `w` invocation re-detects the missing config and re-launches the wizard; no need to instruct the user how to retry.
- **No back navigation.** Wizard is short (~4 screens). Misclicks require re-running. Keeps the state machine simple.

## Error handling

On any unrecoverable wizard error, unmount the Ink surface cleanly and let the error propagate to `main.ts`'s existing top-level `catch`, which already routes through `chrome(e.message)` to stderr and exits 1 (see `src/main.ts:89-92`). No in-dialog error chrome, no inline red text. Matches how every other error in Wrap is reported.


## TUI implementation notes

### Framework and mounting

Ink, lazy-loaded through the existing `src/session/dialog-host.ts` plumbing. Today `preloadDialogModules()` preloads Ink + React + the command-response component (named `Dialog` pre-rename) — after the extraction it preloads `ResponseDialog` and `ConfigWizardDialog` side by side. Mount with `render(<ConfigWizardDialog/>, { stdout: process.stderr, patchConsole: false, alternateScreen: true })`. `mountDialog` is renamed to `mountResponseDialog`; add a sibling `mountConfigWizardDialog`. Stdin-drain-on-mount and `/dev/tty` fallback for piped stdin follow the same pattern.

### Extracting the generic `<Dialog>`

The existing component in `src/tui/dialog.tsx` (~420 lines) is mostly tied to command-response state — the command slot, explanation, plan, output slot, and action bar all belong to `ResponseDialog`. But the **chrome around the content** is pure layout and applies verbatim to the wizard:

- Width calculation from `useWindowSize().columns` + margin
- Top border (`topBorderSegments`)
- Left + right vertical gradient bars sized to inner content height
- Inner `<Box>` with `paddingTop`/`paddingBottom`/`ref` for `useBoxMetrics` height measurement
- Bottom border with optional status text (`bottomBorderSegments`)

Move this into the new `src/tui/dialog.tsx`:

```tsx
type Badge = {
  fg: Color;        // RGB tuple
  bg: Color;
  icon: string;     // 1-2 cell glyph
  label: string;
};

type DialogProps = {
  gradientStops: Color[];          // gradient ramp for top border + left bar
  badge?: Badge;                   // optional badge embedded in top border
  bottomStatus?: string;           // threaded into bottomBorderSegments
  naturalContentWidth: number;     // caller-computed max text width
  children: ReactNode;             // rendered inside the inner Box
};

export function Dialog({ gradientStops, badge, bottomStatus, naturalContentWidth, children }: DialogProps);
```

`Dialog` knows nothing about risk levels, wizards, or any other notion of "what kind of dialog this is". It takes primitive styling inputs and renders a bordered frame around arbitrary children. Callers own the semantics and pick their own stops + badge.

`Dialog` owns: `termCols`, width/height calculation, `useBoxMetrics`, the left/right border arrays, the outer centering `<Box>`, and rendering top/bottom borders via `topBorderSegments`/`bottomBorderSegments`.

**Adjust `border.ts` accordingly.** Today `topBorderSegments(totalWidth, riskLevel)` looks up stops and badge from a `RISK` map keyed by risk level. Change the signature to `topBorderSegments(totalWidth, stops, badge?)` — purely data-driven, no preset lookup. `interpolateGradient` similarly takes `stops` instead of a risk-level key. The `RISK` map itself moves out of `border.ts`:

- **Risk presets for `ResponseDialog`** → a new `src/tui/risk-presets.ts` (or kept co-located with `response-dialog.tsx`). Exports `RISK_PRESETS: Record<RiskLevel, { stops, badge }>`. `ResponseDialog` reads its preset based on the current `riskLevel` from the LLM response and passes `stops` + `badge` into `<Dialog>`.
- **Wizard badge + stops** → hardcoded as constants at the top of `src/tui/config-wizard-dialog.tsx`: `const WIZARD_STOPS = [...]; const WIZARD_BADGE = { fg, bg, icon: "🧙", label: "setup wizard" };`. `ConfigWizardDialog` passes both into `<Dialog>`.

Icon is plain `🧙` rather than a skin-tone + ZWJ variant — the multi-code-point variants render inconsistently across terminals.

Then:

- **`ResponseDialog`** drops ~150 lines of chrome bookkeeping. It imports `RISK_PRESETS`, looks up `const preset = RISK_PRESETS[riskLevel]`, and returns `<Dialog gradientStops={preset.stops} badge={preset.badge} bottomStatus={...} naturalContentWidth={...}>{ response-specific content }</Dialog>`.
- **`ConfigWizardDialog`** returns `<Dialog gradientStops={WIZARD_STOPS} badge={WIZARD_BADGE} bottomStatus={screen.tag === "loading-models" ? "Loading models list…" : undefined}>{ current screen }</Dialog>`.

### List components: `@inkjs/ui`

Ink 7 has no built-in select/multi-select. Add `@inkjs/ui` (v2.0.0, maintained, Ink ≥5 peer dep) as a new dependency when starting implementation. It exports both components the wizard needs:

- **`MultiSelect`** — Screen 1 provider checklist. Props: `options: {label, value}[]`, `defaultValue?: string[]`, `visibleOptionCount?: number`, `onChange(values)`, `onSubmit(values)`. Space toggles, Enter submits, arrows move, native viewport scrolling. Directly fits the checklist screen's requirements.
- **`Select`** — Screen 2b model list and Screen 3 default picker. Same `visibleOptionCount` prop. **Gotcha:** `Select` fires `onChange` on arrow navigation — it has no `onSubmit`. To get Enter-to-confirm semantics, hold the currently-highlighted value in local state via `onChange` and commit on Enter through a `useInput` handler.

Set `visibleOptionCount` from `useWindowSize().rows - chromeHeight` so the viewport always fits the terminal. Cap at ~8 when the terminal is tall to avoid a wall of options for providers with 30+ models.


### Directly reused without modification

- **`src/tui/border.ts`** — `topBorderSegments`, `bottomBorderSegments`, `interpolateGradient`. Used by `Dialog`.
- **`src/tui/text-input.tsx`** — `TextInput`. Add a `masked?: boolean` prop; when true, the `cursor.beforeCursor` / `charAtCursor` / `afterCursor` display renders each character as `•` while the underlying `Cursor` state keeps real characters.
- **`src/core/spinner.ts`** — `SPINNER_FRAMES` + `SPINNER_INTERVAL` for the "Loading models list…" spinner between Screen 1 and Screen 2. The spinner is rendered **inside** Ink (as a React component using `useAnimation` to step through the frames). Do **not** call `startChromeSpinner` from that file — it writes raw `\r` escapes to stderr and fights Ink's alt-screen.
- **`src/session/dialog-host.ts`** — mounting/preloading pattern. Extend to cache `Wizard` alongside `Dialog`.

### Wizard state model

Top-level fields for "what's already been fetched or chosen," plus a tagged `screen` for "what's currently on-screen." A single flat tagged union tempts you to push shared state (fetched models data, selected providers, accumulated entries, loop index) into every variant — error-prone and noisy.

```ts
type WizardState = {
  modelsData: ModelsDevData | null;                   // null until fetched between Screen 1 and Screen 2
  pickedProviders: string[];                          // provider ids ticked on Screen 1
  builtEntries: Record<string, ProviderEntry>;        // config entries accumulated across the per-provider loop
  loopIndex: number;                                  // which `pickedProviders[i]` is being configured
  screen:
    | { tag: "selecting-providers"; checked: Set<string> }
    | { tag: "loading-models" }                       // bottom-border spinner until fetchCached resolves
    | { tag: "entering-key"; provider: string; draft: string }
    | { tag: "picking-model"; provider: string; models: ModelEntry[]; cursor: number }
    | { tag: "disclaimer"; provider: string }
    | { tag: "picking-default"; cursor: number };
};
```

Reducer transitions happen on `screen`; top-level fields are updated when a screen submits. Reducer is pure and unit-testable without mounting Ink.

## Testing

- Unit tests for the reducer covering every screen transition, including the "single provider" skip of Screen 3.
- Unit tests for the models.dev filter (`tool_call`, modalities, `status`) and sort.
- Unit tests for the recommendation logic (regex hit, regex miss).
- Unit tests for the `fetchCached` helper: fresh cache hit, cache miss + network success, cache miss + network failure (throws), stale cache + network failure (returns `stale: true`).
- Unit tests for `writeWrapFile`/`readWrapFile`/`appendWrapFile`: creates parent dirs, handles missing files, round-trips.
- Integration: a fake stdin driver feeds keystrokes into a mounted wizard and asserts the written `config.jsonc`. Uses `ink-testing-library` + `tmpHome()` from `tests/helpers.ts` for `WRAP_HOME` isolation — don't hand-roll `mkdtempSync`.
- All tests use a hand-crafted models.dev fixture, never the network.

## Future work (explicitly deferred)

- **`w --config` / `w --init` flags.** Ship the re-run path together with preselect-from-current-state semantics — wizard reads the existing config, preselects already-configured providers in Screen 1 (checkboxes pre-ticked), prefills their keys and models on the loop screens, and the user's changes (including *unchecking* a provider) overwrite the file. This gives clean removal semantics without a separate "delete this provider" flow and avoids the footgun of a blank-slate rewrite. `w --init` is initially an alias for `w --config`; eventually `--init` grows into a broader first-run orchestrator (config + alias setup + anything else).
- **Env-var detection + Tab-to-fill on the API key screen.** Check `process.env[envVar]` for the names in the provider's models.dev `env` field; if set, show a hint and bind Tab to auto-fill the `$VAR` reference form so the existing `resolveApiKey()` in `src/llm/providers/ai-sdk.ts` dereferences it at runtime. Keeps the config portable across machines for users who already have their keys in the environment.
- **Google (Gemini) support.** Bundle `@ai-sdk/google`, add a `kind: "google"` branch in `src/llm/providers/registry.ts` + factory wiring in `ai-sdk.ts`, uncomment the `google` entry in `API_PROVIDERS`. Tracked in `specs/todo.md`.
- **Bundled models.dev snapshot.** If offline-first-run becomes a real pain point, add a dev build script that trims models.dev to curated providers and ships it with the binary. v1 fails cleanly offline instead.
- **"More providers…" picker.** Full searchable list of openai-compatible providers from models.dev, merged into the shortlist UI. Auto-populates baseURL from models.dev's `api` field.
- **Repair mode.** On `loadConfig` failure against an existing (malformed) file, auto-launch the wizard in a mode that highlights which provider is broken.
- **Advanced fields.** `maxRounds`, `verbose`, etc. exposed through a second wizard path (`w --config advanced`?).
- **API key validation.** Hit a cheap provider endpoint to verify the key works before saving.

## Implementation plan

Stages land in order. The first five are independent of one another except where noted and can also each be split further if they grow — each ends in a committable, non-regressing state. The wizard itself is split across the last three stages; those last three intentionally leave the tree in partially-wired states between commits, which is fine.

1. **`wrap-home-dir` helper + migrations.** Centralize `~/.wrap/*` I/O through one module and migrate the existing inline `mkdirSync`/`readFileSync`/`writeFileSync`/`appendFileSync` sites onto it. Fixes the `watchlist.ts` missing-parent crash as a side effect. No behavior change anywhere else.

2. **`Dialog` extraction + rename.** Separate the generic bordered chrome from the command-response content. Pure refactor — confirmation dialog renders identically after.

3. **`fetchCached` helper.** Standalone cache+fetch primitive with the semantics described in [Generic cache helper](#generic-cache-helper). No consumers yet. Depends on stage 1.

4. **Provider registry consolidation.** Replace the flat `KNOWN_PROVIDERS` map with `API_PROVIDERS` + `CLI_PROVIDERS` maps that also carry the wizard's display metadata. Runtime behavior unchanged; adding providers now has a single touch point.

5. **`resolveProvider` claude-code exemption.** Allow a `claude-code` entry to have no `model` field without throwing. Small correctness fix; manually-edited configs with `{"claude-code": {}}` start working.

6. **Wizard reducer + data pipeline.** Pure-logic scaffolding: `WizardState` type and reducer, provider-selection flow, model filter + sort + recommendation logic, pre-write `validateProviderEntry` pass, config-write path. No UI yet — reducer is exercised by unit tests only. Tree doesn't run the wizard at runtime; nothing in `main.ts` changes yet. This is where every screen-transition edge case and every filter/sort invariant gets nailed down in isolation from Ink.

7. **Wizard UI (`ConfigWizardDialog`) mountable via harness.** Connect the reducer from stage 6 to `<Dialog>` and `@inkjs/ui` components. Add the masked `TextInput` prop. Wire up the dialog-host preload/mount plumbing. The component is exercisable via `ink-testing-library` and via a one-off mount script, but `main.ts` still doesn't call it — fresh installs still see the old `Config error: no LLM configured` dead-end. End of this stage: the wizard renders correctly in tests and is visually reviewable.

8. **`ensureConfig` wiring.** Replace `loadConfig()` in `main.ts` with `ensureConfig()`, bundle `config.schema.json` via static JSON import, handle cancel via `process.exit(0)`. This is the stage that actually flips first-run behavior. Small diff because everything underneath already works.

### Stage dependencies

Stages 1–5 are mutually independent except for stage 3 depending on stage 1. Stages 6–8 run sequentially and depend on all five prerequisites.
