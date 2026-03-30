# Wrap — Runtime Architecture

> How Wrap runs: flow from invocation to execution, module responsibilities, and key design decisions.

---

## Top-Level Flow

```
parseInput(argv)
       │
       ├─ readPipedInput()  ──→ reads stdin if piped, returns string | null  [NOT YET IMPLEMENTED]
       │
       ├─ flag? ──→ dispatch subcommand (exit)
       │
       ├─ no args? ──→ dispatch --help (exit)  [will change: no args + pipe → piped input becomes prompt]
       │
       ├─ loadConfig()  ──→ loads config from file + env
       │
       ├─ initProvider()  ──→ factory: config → Provider
       │
       ├─ probeTools()  ──→ `which` for available tools (~5ms, every run)
       │
       ├─ ensureMemory()  ──→ loads memory or initializes with probes
       │
       ├─ resolvePath(cwd)  ──→ canonical CWD
       │
       └─ runQuery({ prompt, provider, memory, cwd, toolsOutput })
```

Subcommands (including `--help` for no-args) short-circuit before `loadConfig()`. They handle their own prerequisites — `--log` only needs `WRAP_HOME`, not config or memory.

When piped input is implemented (see `specs/piped-input.md`), `readPipedInput()` will run eagerly before subcommand dispatch, and the no-args branch will check for piped content before dispatching `--help`.

---

## Prerequisites

- **`loadConfig()`** — Reads config from `~/.wrap/config.jsonc` + `WRAP_CONFIG` env var (shallow merge). Returns `Config`. Caller checks for missing provider — will become an "ensure" function when the first-run wizard is built.
- **`probeTools()`** — Runs `which` for all tools in `PROBED_TOOLS` (package managers, dev tools, clipboard utilities). Runs every startup, not stored in memory — see `specs/discovery.md` for details.
- **`ensureMemory(provider, wrapHome)`** — The "ensure" pattern: loads existing memory or creates it (probes OS/shell/config, sends to LLM, saves as global facts). Either returns `Memory` or throws. The caller never checks.

---

## The Query Loop

Currently single-shot: one LLM call, optional round retry, then execute or print. The full multi-round loop (probes, error retries, unified round counter) is designed but not yet implemented — see `specs/SPEC.md` sections 6-7 for the target behavior.

**Current flow** (in `src/core/query.ts`):
1. Assemble context (system prompt + few-shot + memory + tools + user prompt)
2. Call LLM → get structured `CommandResponse`
3. On structured output error → round retry once with failed output appended
4. Handle memory updates (write immediately, notify user)
5. Route by response type: answer → stdout, probe → error (not yet supported), command → execute if low-risk

### Loop Rules (Design — for when the multi-round loop is implemented)

| Rule | Rationale |
|---|---|
| Unified counter for probes + error-fix rounds | One budget prevents runaway loops regardless of response type. |
| Memory writes are immediate | A probe that discovers `shell=zsh` is useful even if the final command fails. Updates both disk and in-memory state so the next LLM call in the same loop sees it. |
| User-edited commands don't get auto-fix | The user took manual control — don't second-guess with LLM auto-fix. |
| Multi-turn conversation context | Probes/errors become conversation turns, giving the LLM full history for each subsequent call. |

---

## Module Structure

```
src/
  index.ts                    Entry point
  main.ts                     Top-level orchestration
  prompt.optimized.ts         DSPy-generated: system prompt, schema text, few-shot examples, voice instructions, prompt hash
  command-response.schema.ts  Zod schema for LLM command/answer/probe responses

  core/
    input.ts                  CLI arg parsing (prompt | flag | none)
    query.ts                  Query execution, round retry, command execution
    parse-response.ts         JSON parsing + schema validation
    paths.ts                  resolvePath() + prettyPath()
    output.ts                 isTTY(), hasJq(), chrome() (stderr output)
    home.ts                   getWrapHome() — resolves ~/.wrap or WRAP_HOME
    ansi.ts                   ANSI color/style utilities

  config/
    config.ts                 Config loading + merging (file + env var)
    config.schema.json        JSON Schema for editor support

  llm/                        See specs/llm-sdk.md
    types.ts                  Provider interface, PromptInput, config types
    index.ts                  initProvider() dispatch + runCommandPrompt()
    context.ts                assembleCommandPrompt() — system + memory + tools + messages
    utils.ts                  Shared LLM utilities (stripFences, etc.)
    providers/
      ai-sdk.ts               Anthropic + OpenAI via Vercel AI SDK
      claude-code.ts           Claude CLI subprocess provider
      test.ts                  Deterministic test mock

  logging/                    See specs/logging.md
    entry.ts                  Log entry type, creation, round management
    writer.ts                 JSONL append to ~/.wrap/logs/wrap.jsonl

  memory/                     See specs/memory.md
    types.ts                  Fact, FactScope, Memory types
    memory.ts                 load, save, append, ensure (init flow)
    init-probes.ts            Init probe commands (OS, shell) + runtime tool probe
    init-prompt.ts            LLM prompt for parsing probe output into facts

  subcommands/                See specs/subcommands.md
    types.ts                  Subcommand type
    registry.ts               All subcommands registered here
    dispatch.ts               Flag matching + dispatch
    help.ts                   --help (auto-generated from registry)
    version.ts                --version
    log.ts                    --log (raw/pretty, search, filtering)
```

Runtime data at `~/.wrap/` (overridable via `WRAP_HOME`):
- `config.jsonc` — user config
- `memory.json` — scoped facts (see `specs/memory.md`)
- `logs/wrap.jsonl` — invocation logs (see `specs/logging.md`)

---

## Mode

Mode is a string (`"smart" | "yolo" | "force-cmd" | "force-answer" | "confirm-all"`) resolved from the invocation name or flags and passed to `runQuery`. **Not yet implemented** — all invocations currently behave as smart mode with only low-risk commands auto-executing; medium/high-risk commands are refused.

Mode affects:
- **Confirmation**: yolo skips, confirm-all always shows, smart checks risk level
- **Response handling**: force-cmd / force-answer constrain LLM behavior

---

## Design Decisions

### Why not pipeline/middleware?

Considered and rejected. Wrap has a fixed, small set of flows — the composability of a pipeline pattern doesn't pay for its costs (implicit ordering dependencies, shared mutable context bag with optional fields, indirection). Sequential code with good function decomposition is simpler, more explicit, and more testable.

### Why not hybrid resolve/execute?

A pure `resolve()` → `execute()` separation breaks down when flows continue after prerequisites. First-run setup creates config, then the query should proceed — not re-resolve. The ensure pattern handles this naturally: `ensureConfig()` returns and the next line runs.
