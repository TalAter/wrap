# Settings Refactor

> **Status:** Planned. Working spec — see end-of-file note about trimming after implementation.

## Problem

Settings can come from three sources: CLI flag, env var, config file. Today each setting is resolved ad-hoc:

- `verbose` merged in `main.ts`: `modifiers.flags.has("verbose") || config.verbose === true`
- `noAnimation` partially in `main.ts`, partially in `shouldAnimate()` (which independently reads `WRAP_NO_MOTION`)
- `model` via a separate `resolveProvider()` chain
- `nerdFonts`, `maxRounds`, etc. read straight from `getConfig()` with fallback constants at call sites

No shared precedence rule. No single registry of "settings." Env and config names drift (`noAnimation` vs `WRAP_NO_MOTION`). Help text overpromises (claims `WRAP_NO_MOTION=1` disables animations, but the TUI spinners ignore it).

## Goals

- One registry describing every multi-source setting.
- One resolver with uniform precedence: **CLI > env > file > default**.
- `getConfig()` always returns a fully-merged view with defaults materialized.
- Kill scattered env checks and per-setting fallback constants.

## Design

### SETTINGS registry — `src/config/settings.ts`

Canonical list of user-settable values. Each entry declares available sources, description, and default. Fields other than `type` and `description` are all optional — a setting may have any subset of {flag, env, config}.

```ts
export const SETTINGS = {
  verbose: {
    type: "boolean",
    description: "Enable debug output on stderr",
    usage: "w --verbose",
    flag: ["--verbose"],
    default: false,
  },
  noAnimation: {
    type: "boolean",
    description: "Disable animations",
    usage: "w --no-animation",
    flag: ["--no-animation"],
    env: ["WRAP_NO_ANIMATION"],
    default: false,
  },
  model: {
    type: "string",
    description: "Override LLM provider/model",
    usage: "w --model <provider[:model]>",
    flag: ["--model", "--provider"],
    env: ["WRAP_MODEL"],
    // No default — absence means "use config-defined provider."
  },
  nerdFonts: {
    type: "boolean",
    description: "Use Nerd Font glyphs in terminal output",
    default: false,
  },
  maxRounds: {
    type: "number",
    description: "Max LLM rounds per prompt",
    default: 5,
  },
  // ... maxCapturedOutputChars, maxPipedInputChars, etc.
} as const;
```

**Conventions:**

- Setting key === Config key. Implicit. Add `config: false` only if a setting should not persist.
- `flag` and `env` are both `string[]`. Aliases supported uniformly.
- Setting absence from `flag` means no CLI surface. Same for `env`.
- `description`, `usage`, `help` live here so future help expansion (env var mention, config docs, `w --help <setting>`) reads one source.

### Resolver — `src/config/resolve.ts`

One function. Precedence: **CLI > env > file > default**. Builds the full Config by layering sources low-to-high.

```ts
export function resolveSettings(
  modifiers: Modifiers,
  env: NodeJS.ProcessEnv,
  fileConfig: Config,
): Config
```

**Rule:** always rebuild from layers. Never incremental-merge onto the store. `setConfig()` receives a complete Config each time; defaults are re-applied as the lowest layer on every rebuild. A seeded CLI value never gets "overwritten" by a file value because both are layered fresh, in the right order.

```ts
// Conceptually, per setting:
finalValue = cli ?? env ?? file ?? default
```

**Boolean sources:** CLI flag presence → `true`. Env var presence (any non-empty value) → `true`. Undefined otherwise.

**String sources:** CLI flag value, or env var value. Undefined otherwise.

**Custom merge — model:** `--model anthropic:claude-opus` means "set `defaultProvider=anthropic` AND `providers.anthropic.model=claude-opus`." Does NOT touch the `providers` map otherwise. Resolver has a hardcoded branch for the `model` key — it reads the resolved string, splits on `:`, and produces a Partial<Config> fragment that layers on top of the file config's `defaultProvider` / `providers[x].model` without replacing the map.

### `noAnimation` aggregation

`config.noAnimation` is the only "should we animate?" state. It folds user intent and env-wide capability signals at resolve time:

```
config.noAnimation = userSays(cli/env/file) || CI || TERM=dumb || NO_COLOR
```

`CI`, `NO_COLOR`, `TERM` are terminal-capability env vars — not settings, not in SETTINGS. They feed resolver logic for `noAnimation` only.

**Per-stream TTY** (e.g. `stderr.isTTY` for chrome spinner) stays local at the call site — it's channel-specific, not a global signal. Pattern at animation sites:

```ts
if (config.noAnimation || !stream.isTTY) { /* skip animation */ }
```

`shouldAnimate()` is reduced to `!getConfig().noAnimation` (or inlined; decide during implementation). `supportsColor()` stays separate — color capability ≠ animation preference.

### `main.ts` flow

```ts
const { modifiers, input } = parseArgs(process.argv, MODIFIER_SPECS);

// Seed: CLI + env + defaults. No file yet; subcommands may not need it.
setConfig(resolveSettings(modifiers, process.env, {}));

if (input.type === "flag") { await dispatch(...); return; }

// Session path: re-resolve with file config layered in.
const fileConfig = await ensureConfig();
setConfig(resolveSettings(modifiers, process.env, fileConfig));
```

### CLI options — derived from SETTINGS

Drop the hand-written `options` array from `src/subcommands/registry.ts`. Options are derived from SETTINGS entries that have `flag`:

```ts
// src/subcommands/registry.ts
export const options: Option[] = buildOptionsFromSettings(SETTINGS);
```

`commands` array (help, log, version) stays hand-written — commands aren't settings.

### Help rendering

`renderFlagHelp()` reads description/usage/help from the SETTINGS entry for options. For future `w --help <setting-name>` or `w config list`, the same metadata is available regardless of CLI surface.

## Renames

- Env var `WRAP_NO_MOTION` → `WRAP_NO_ANIMATION`. Hard drop — no alias. Branch is unmerged.
- `shouldAnimate()` — drop param `opts?.enabled` (already dead after earlier change). Reduce body to a simple config read, or inline.

## Implementation order

1. Drop `WRAP_NO_MOTION`, rename to `WRAP_NO_ANIMATION` — keep resolution ad-hoc for now.
2. Drop dead `opts?.enabled` from `shouldAnimate()`.
3. Create `src/config/settings.ts` with SETTINGS for `verbose`, `noAnimation`, `model`, plus config-only entries for `nerdFonts`, `maxRounds`, etc.
4. Create `src/config/resolve.ts`. Unit tests for precedence, boolean/string coercion, `model` custom merge, `noAnimation` aggregation.
5. Rewrite `main.ts` to use `resolveSettings`. Derive options from SETTINGS in `subcommands/registry.ts`.
6. Fold CI/TERM/NO_COLOR into `noAnimation` at resolve time. Simplify `shouldAnimate()`.
7. Remove scattered `?? DEFAULT_X` constants where SETTINGS now provides the default.
8. Update help text — remove `WRAP_NO_MOTION` mention, let derived help show `WRAP_NO_ANIMATION` from SETTINGS.

## Open questions

- Should `shouldAnimate()` stay as a named helper or be inlined? Leaning: keep as thin helper (one call site per animation surface), but remove the param.
- Should `nerdFonts` / `maxRounds` etc. live in SETTINGS even though they're config-only? Yes — single registry for all settings lets us auto-generate config docs / schema later.
- Validation / type coercion for env-var string values of non-string settings (e.g. a future `WRAP_MAX_ROUNDS=5`)? Out of scope for this round; add `parse` field to SETTINGS if needed later.

---

## ⚠️ Post-implementation cleanup (REQUIRED)

After this refactor lands and is committed, this spec file is a **working doc** — it must be trimmed heavily before merging back to main.

**During the same spec-compact round:**

1. **Trim this file** — keep only the precedence rule, the SETTINGS shape, the resolver contract, and the `noAnimation` aggregation rule. Drop the problem/motivation narrative, implementation order, and open questions.

   **Where trimmed content lands — decide during compact.** Candidates:
   - A brief mention in `specs/subcommands.md` (options are the CLI surface).
   - Promote `specs/config-wizard.md` → `specs/config.md` covering the full config story (schema, sources, precedence, wizard). The settings system may fit best there.
   - Model-override specifics may or may not belong in `specs/llm.md` — check what's already there.

   Do not pre-commit to a destination. Read the landscape at compact time.

   **Also add to the final spec:** a note that `src/config/config.schema.json` must stay in sync with SETTINGS — any new setting that persists in config needs a schema entry for jsonc validation/IDE support.

2. **Delete `specs/verbose.md`** — fold its essentials:
   - Verbose pipeline steps list → keep in `verbose.md` OR move to `session.md`/`logging.md` (decide during compact)
   - `--verbose` as a setting → covered by settings system
   - `verbose()` helper behavior → one paragraph in `logging.md` or inline at call sites

3. **Delete this file** (`specs/settings-refactor.md`) once its content has been absorbed elsewhere.

Flag this cleanup in the worktree pre-merge checklist.
