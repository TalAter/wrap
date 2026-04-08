# Wrap — Runtime Architecture

> How Wrap runs: flow from invocation to execution, module responsibilities, and key design decisions.

---

## Top-Level Flow

```
extractModifiers(argv)  ──→ { modifiers, remaining }
       │
parseInput(remaining)
       │
       ├─ readPipedInput()  ──→ reads stdin if piped, returns string | null  [NOT YET IMPLEMENTED]
       │
       ├─ flag? ──→ dispatch subcommand (exit)
       │
       ├─ no args? ──→ dispatch --help (exit)  [will change: no args + pipe → piped input becomes prompt]
       │
       ├─ loadConfig()  ──→ loads config from file + env
       │
       ├─ initVerbose()  ──→ enables verbose if flag or config
       │
       ├─ initProvider()  ──→ factory: config → Provider
       │
       ├─ loadWatchlist() + probeTools()  ──→ `which` for defaults + watchlist
       │
       ├─ ensureMemory()  ──→ loads memory or initializes with probes
       │
       ├─ resolvePath(cwd)  ──→ canonical CWD
       │
       └─ runQuery({ prompt, provider, memory, cwd, tools })
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

Multi-round loop in `src/core/query.ts`. Assembles context once, then loops up to `maxRounds` times. Each iteration: call LLM → route by response type.

**Flow per round:**
1. If last round → inject "do not probe" instruction
2. Call LLM (with round retry on structured output parse failure)
3. If non-low-risk probe → retry once within the round, refuse if still non-low
4. Handle memory updates (write to disk immediately, notify user on stderr)
5. Handle watchlist additions
6. Route: answer → stdout, probe → execute + capture + append to conversation, command → execute if low-risk

### Loop Rules

| Rule | Rationale |
|---|---|
| Unified counter for probes + error-fix rounds | One budget (`maxRounds`, configurable, default 5) prevents runaway loops regardless of response type. |
| Rounds only tick for autonomous LLM calls | The round budget prevents runaway loops *without user intervention*. User-initiated actions don't consume budget: **Describe** doesn't decrement it (side-channel explanation, not command generation). **Follow-up** resets the budget to a fresh `maxRounds` so the user can refine without hitting the cap, but round numbers keep incrementing across the conversation — a probe after a follow-up shows up as round 5 in the log, not a new round 1. |
| Memory writes are immediate | A probe that discovers `shell=zsh` is useful even if the final command fails. Writes to disk; context is not rebuilt per round (the LLM already knows what it discovered). |
| Multi-turn conversation context | Probes become assistant/user turn pairs, giving the LLM full history for each subsequent call. |
| Last-round constraint | "Do not probe" instruction injected on the final round. No budget info sent on earlier rounds — avoids polluting every request. |
| User-edited commands don't get auto-fix | The user took manual control — don't second-guess with LLM auto-fix. (Not yet implemented.) |

### Error-Fix Rounds (Design — not yet implemented)

When a command fails with an infrastructure-level error (command not found, syntax error, wrong flags — not application-level failures like 404s), the error output (stderr) is fed back to the LLM as a conversation turn for auto-fix. This shares the same loop and round budget as probes.

The LLM decides the fix strategy: most tools include usage help in their error messages (`grep: unrecognized option` prints valid flags), so the error alone is often enough. For cryptic errors, the LLM can spend a probe round on `<tool> --help` or `tldr <tool>` (if installed — known from the tool probe). Wrap doesn't auto-enrich errors with help output; the LLM makes that cost/benefit decision within the round budget.

See `specs/SPEC.md` §6 for the full error-handling design (auto-fix scope, command-not-found memory updates, informational vs fixable errors).

---

## Module Structure

```
src/
  index.ts                    Entry point
  main.ts                     Top-level orchestration
  prompt.constants.json       Shared prompt strings (section headers, fixed instructions)
  prompt.optimized.json       DSPy-generated: instruction, schema text, few-shot examples, prompt hash
  command-response.schema.ts  Zod schema for LLM command/answer/probe responses

  core/
    input.ts                  CLI arg parsing (prompt | flag | none)
    query.ts                  Query execution, round retry, command execution
    parse-response.ts         JSON parsing + schema validation
    paths.ts                  resolvePath() + prettyPath()
    output.ts                 isTTY(), hasJq(), chrome() (stderr output)
    home.ts                   getWrapHome() — resolves ~/.wrap or WRAP_HOME
    ansi.ts                   ANSI color/style utilities
    verbose.ts                Verbose mode: initVerbose() + verbose()

  config/
    config.ts                 Config loading + merging (file + env var)
    config.schema.json        JSON Schema for editor support

  llm/                        See specs/llm-sdk.md
    types.ts                  Provider interface, PromptInput, config types
    index.ts                  initProvider() dispatch + runCommandPrompt()
    context.ts                assembleCommandPrompt() — thin wrapper over format-context + build-prompt
    format-context.ts         Pure: memory + tools + cwd → context string
    build-prompt.ts           Pure: config + context + query → PromptInput
    utils.ts                  Shared LLM utilities (stripFences, etc.)
    providers/
      ai-sdk.ts               Anthropic + OpenAI via Vercel AI SDK
      claude-code.ts           Claude CLI subprocess provider
      test.ts                  Deterministic test mock

  logging/                    See specs/logging.md
    entry.ts                  Log entry type, creation, round management
    writer.ts                 JSONL append to ~/.wrap/logs/wrap.jsonl

  discovery/                  See specs/discovery.md
    init-probes.ts            Init probe commands (OS, shell) + runtime tool probe
    cwd-files.ts              CWD file listing (readdir + lstat, mtime sorted, cap 50)

  memory/                     See specs/memory.md
    types.ts                  Fact, FactScope, Memory types
    memory.ts                 load, save, append, ensure (init flow)
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

Mode is a string (`"smart" | "yolo" | "force-cmd" | "force-answer" | "confirm-all"`) resolved from the invocation name or flags and passed to `runQuery`. **Not yet implemented** — all invocations currently behave as smart mode: low-risk commands auto-execute, medium/high-risk commands show a confirmation panel (Ink TUI on stderr).

Mode affects:
- **Confirmation**: yolo skips, confirm-all always shows, smart checks risk level
- **Response handling**: force-cmd / force-answer constrain LLM behavior

---

## Design Decisions

### Why not pipeline/middleware?

Considered and rejected. Wrap has a fixed, small set of flows — the composability of a pipeline pattern doesn't pay for its costs (implicit ordering dependencies, shared mutable context bag with optional fields, indirection). Sequential code with good function decomposition is simpler, more explicit, and more testable.

### Why not hybrid resolve/execute?

A pure `resolve()` → `execute()` separation breaks down when flows continue after prerequisites. First-run setup creates config, then the query should proceed — not re-resolve. The ensure pattern handles this naturally: `ensureConfig()` returns and the next line runs.
