# Wrap — Runtime Architecture

High-level map of how an invocation flows through the code. Details live in the area sub-specs; this file is the orientation you read first.

---

## Top-level flow

```
parseArgs(argv)             strip modifier options (--verbose, --model, --no-animation)
    │
resolveSettings + setConfig seed store from CLI + env + defaults (see config.md)
    │
dispatch subcommand?   ──→  yes: run subcommand, exit (see subcommands.md)
    │
ensureConfig                config.jsonc exists? load it : run wizard (see config.md)
    │
resolveSettings + setConfig re-resolve with file config layered in
    │
resolveProvider             getConfig() + model override → ResolvedProvider (see llm.md)
    │
probeTools + loadWatchlist  `which` every entry (see discovery.md)
    │
ensureMemory                load or initialize memory (see memory.md)
    │
runSession                  state machine: rounds × LLM × dialog × execute
    │
appendLogEntry              JSONL at ~/.wrap/logs/wrap.jsonl (see logging.md)
```

Subcommands short-circuit before `ensureConfig` — `--log` only needs `$WRAP_HOME`, not file config or memory. Seeded config (CLI + env + defaults) is still available to them. See `subcommands.md` for the registry and dispatch rules.

---

## The session loop

The heart of an interactive invocation lives in `src/session/`. The session owns:

- **AppState reducer** (`reducer.ts`) — pure state machine driving the dialog (`confirming` / `editing` / `composing` / `processing`).
- **pumpLoop** (`session.ts`) — drives the query loop, dispatches post-transition hooks (`submit-followup`, etc.), and is the single caller that mounts/unmounts the dialog.
- **Dialog host** (`dialog-host.ts`) — lazy-loads Ink + React, mounts/rerenders/unmounts.
- **Notification router** (`notification-router.ts`) — subscribes to the global notification bus and routes each event to stderr, to the buffered replay queue, or to the dialog's bottom border. It is the single source of truth for "is a dialog up?".

The query loop itself (one round at a time) lives in `src/core/`:

- `runner.ts` — generator over rounds; enforces `maxRounds`, injects the last-round instruction (forbids `final: false`) on the final iteration.
- `round.ts` — a single round: call LLM, parse, classify, execute.
- `transcript.ts` — semantic conversation turns (`user`, `step`, `confirmed_step`, `candidate_command`, `answer`) with an attempt directive attached to the latest turn. Also owns `projectResponseForEcho`, the single place that decides which response fields the LLM sees in echoed turns.
- `parse-response.ts`, `shell.ts`, `notify.ts`, `input.ts`, `output.ts`, `spinner.ts`, `piped-input.ts`, `verbose.ts`, `ansi.ts`, `paths.ts` — pure-ish supporting modules. Filesystem helpers (`readWrapFile`, `writeWrapFile`, `fetchCached`) live in `src/fs/`.

**Why session is separate from core:** `core` is "run one round, return a result"; `session` is "loop those rounds while a dialog may be mounted and events may be dispatched." Separating them keeps the pure loop testable in isolation from the Ink/React surface. See `session.md` for the full rationale (and the six problems that drove the refactor).

---

## Module layout

```
src/
  index.ts                       bin entry
  main.ts                        top-level orchestration
  command-response.schema.ts     Zod schema for LLM responses
  prompt.constants.json          fixed instructions and section headers
  prompt.optimized.json          DSPy-generated: instruction + demos + schema text + hash

  core/                          pure loop + shared primitives
    runner.ts                    generator over rounds
    round.ts                     one round: LLM → parse → classify → execute
    transcript.ts                semantic conversation turns
    parse-response.ts            JSON + Zod validation + stripFences
    shell.ts                     spawn + inherit stdio
    notify.ts                    typed notification bus
    input.ts                     argv → { prompt, modifiers, pipedInput }
    output.ts                    chrome() / chromeRaw() — stderr sink
    piped-input.ts               stdin reader (TTY detection, byte cap)
    verbose.ts                   notification → narrative stderr line
    spinner.ts                   animated chrome without Ink
    ansi.ts                      RGB interpolation + styling primitives
    paths.ts                     path helpers

  fs/                            ~/.wrap/ filesystem helpers
    home.ts                      getWrapHome, readWrapFile, writeWrapFile, appendWrapFile
    cache.ts                     fetchCached (TTL + disk cache)
    temp.ts                      createTempDir + formatTempDirSection

  session/                       stateful loop + dialog lifecycle
    session.ts                   pumpLoop, runSession, post-transition hooks
    reducer.ts                   pure state machine (AppState × AppEvent)
    state.ts                     AppState / AppEvent / ActionId / isDialogTag
    dialog-host.ts               Ink lazy-load + mount/rerender/unmount
    notification-router.ts       dialog-aware notification routing

  tui/                           Ink presentation layer — see tui.md
    dialog.tsx                   generic bordered chrome (gradient bars, badge, status)
    response-dialog.tsx          command-response dialog (risk levels, action bar)
    config-wizard-dialog.tsx     config wizard (multi-screen state machine)
    checklist.tsx                multi-select with ✓/· indicators and group headers
    risk-presets.ts              per-risk-level gradient stops + badge
    border.ts                    gradient interpolation, badges
    text-input.tsx               custom editable field (word jump, kill, yank, masked mode)
    cursor.ts                    Cursor abstraction for text-input

  llm/                           see llm.md
    index.ts                     initProvider dispatch + runCommandPrompt
    types.ts                     Provider interface, PromptScaffold, Config shape
    resolve-provider.ts          config + overrides → ResolvedProvider
    build-prompt.ts              config + context + query → PromptScaffold
    format-context.ts            memory + tools + cwd → context string
    context.ts                   thin wrapper over format-context + build-prompt
    utils.ts                     stripFences, toOpenAIStrictSchema, etc.
    providers/
      ai-sdk.ts                  Anthropic + OpenAI-compat via Vercel AI SDK
      claude-code.ts             Claude CLI subprocess provider
      test.ts                    Deterministic test mock
      registry.ts                API_PROVIDERS + CLI_PROVIDERS taxonomy + wizard metadata

  config/                        see config.md
    config.ts                    Config + ResolvedConfig types, file/env loader
    settings.ts                  SETTINGS registry — flag/env/config/default metadata
    resolve.ts                   resolveSettings — precedence CLI > env > file > default
    store.ts                     global config store (setConfig / getConfig / updateConfig)
    ensure.ts                    ensureConfig — wizard on missing config
    config.schema.json           JSON Schema for editor support

  wizard/                        config wizard pure logic (see config.md)
    state.ts                     ProviderWizardState + reducer (screen transitions)
    models-filter.ts             models.dev filter/sort/recommendation
    write-config.ts              buildConfig + serialize + write

  discovery/                     see discovery.md
    init-probes.ts               first-run probes (OS, shell)
    cwd-files.ts                 CWD file listing (mtime sorted, capped)
    watchlist.ts                 tool watchlist load/save

  memory/                        see memory.md
    types.ts                     Memory, Scope, Fact, FactScope
    memory.ts                    load / save / append / ensure
    init-prompt.ts               LLM prompt for parsing probe output into facts

  logging/                       see logging.md
    entry.ts                     LogEntry construction + round management
    writer.ts                    JSONL append (failures swallowed)

  subcommands/                   see subcommands.md
    registry.ts                  all commands + options declared here
    dispatch.ts                  flag matching + dispatch (commands only)
    help.ts, version.ts, log.ts  individual commands
    types.ts                     CLIFlag type (Command | Option)
```

Runtime data at `~/.wrap/` (overridable via `$WRAP_HOME`):
- `config.jsonc` — user config
- `memory.json` — scoped facts
- `tool-watchlist.json` — persistent tool names to `which`
- `logs/wrap.jsonl` — invocation logs

---

## Design decisions that cross layers

### Sequential code, not pipeline/middleware

Considered and rejected. Wrap has a small fixed set of flows — the composability of a pipeline pattern doesn't pay for its costs (implicit ordering dependencies, shared mutable context bag with optional fields, indirection). Sequential code with good function decomposition is simpler, more explicit, and more testable.

### Ensure-pattern over resolve/execute split

A pure `resolve()` → `execute()` split breaks when flows continue after prerequisites. First-run setup creates config, then the query should proceed — not re-resolve. `ensureConfig()` / `ensureMemory()` return and the next line runs.

### Global config store, not prop drilling

`src/config/store.ts` — any module reads config via `getConfig()` without receiving it as a parameter. The store holds a `ResolvedConfig` (Config with SETTINGS defaults materialized); `setConfig` refuses anything less. See `config.md` for the full sources/precedence/resolver story.

**Replaces per-setting singletons.** `initNerdFonts()` and `initVerbose()` are eliminated. `resolveIcon()` reads `getConfig().nerdFonts`. `verbose()` reads `getConfig().verbose`. Session options like `maxRounds` read from `getConfig()` instead of being passed through `SessionOptions`.

**`updateConfig(patch)` for mid-flight mutation.** Shallow-merges into the current config, skipping `undefined` values. Primary consumer: the config wizard, updating settings (e.g. `nerdFonts`) between screens so later screens read them via `getConfig()`.

### Core is pure; session owns the world

`core/runner.ts` is a generator — hand it a transcript and a provider and it yields rounds. `session/session.ts` wraps that with an Ink dialog, a state reducer, and an event-dispatch closure. Tests pin the session's full lifecycle without needing Ink; tests pin the runner without needing the session. See `session.md` for the history of this split.

### The notification bus is the only stderr sink while a dialog is mounted

Any direct `process.stderr.write` during alt-screen lands in the alt buffer and vanishes on exit. All chrome flows through `notify()` → notification router → (stderr | buffer | dialog). See `tui.md` and `session.md`.

### Prompt scaffold, not prompt string

Prompts are assembled as a `PromptScaffold` (`system` + `prefixMessages` + `initialUserText`) rather than a concatenated string. Cache-friendly ordering, deterministic tests, and the ability to inject few-shot examples as real conversation turns. See `llm.md`.

---

## Where to go next

- **Changing a dialog behavior?** → `tui.md` + `session.md`
- **Adding a provider?** → `llm.md` § Extending
- **Changing what the LLM sees?** → `llm.md` § Prompt scaffold + `discovery.md`
- **Changing when a command is blocked?** → `safety.md`
- **Changing what gets logged?** → `logging.md`
- **Adding a setting / changing precedence?** → `config.md`
- **Adding a subcommand?** → `subcommands.md`
- **Multi-step flows?** → `multi-step.md` (planned; blocked on session architecture it builds on)
