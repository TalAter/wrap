# Wrap — Runtime Architecture

> Describes how Wrap runs: the flow from invocation to execution, module responsibilities, and key design decisions.

---

## Top-Level Flow

```
parseInput(argv)
       │
       ├─ subcommand? ──→ runSubcommand()  (exit)
       │
       ├─ ensureConfig()  ──→ loads config or runs wizard (throws/exits on failure)
       │
       ├─ ensureMemory()  ──→ loads memory or initializes with basic probes
       │
       ├─ resolvePath(cwd)  ──→ canonical CWD
       │
       ├─ no prompt? ──→ showHelp()  (exit)
       │
       ├─ continuation? ──→ loadThread()
       │
       └─ runQuery({ prompt, mode, config, memory, cwd, thread?, pipedInput? })
```

```ts
// src/core/main.ts — the entire flow, readable at a glance
async function main() {
  const input = parseInput(process.argv)

  if (input.subcommand) return runSubcommand(input.subcommand)

  const config = await ensureConfig()
  const memory = await ensureMemory()
  const cwd = resolvePath(process.cwd())  // resolved once, passed through

  if (!input.prompt) return showHelp()

  const mode = resolveMode(input)  // TBD: how modes are detected/resolved
  const thread = input.isContinuation ? await loadThread() : null

  await runQuery({ prompt: input.prompt, mode, config, memory, cwd, thread })
}
```

---

## The Ensure Pattern

Prerequisites use the "ensure" pattern: load existing state or create it, then return. Either a value comes back or the function throws/exits. The caller never checks.

- **`ensureConfig()`** — Reads config or runs the setup wizard. Throws on abort. Returns `Config`.
- **`ensureMemory()`** — Reads memory or initializes (detects OS, shell, basic env). Returns `Memory` (`Record<string, Fact[]>`).

---

## The Query Loop

A single `for` loop handles probes, commands, answers, and error retries. Probes and retries share a **unified counter** (one budget for all LLM round-trips).

LLM context is a **multi-turn conversation** (message array). Each probe result and error becomes a conversation turn, giving the LLM full history for each subsequent call.

```ts
// src/core/query.ts
async function runQuery(params) {
  const conversation = startConversation(params)

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await callLLM(conversation)

    // Memory updates are written immediately, even mid-loop
    if (response.memory_updates) {
      await saveMemory(response.memory_updates)
      notify(response.memory_updates_message)
    }

    switch (response.type) {
      case "answer":
        return printAnswer(response)

      case "probe":
        const probeResult = await executeProbe(response.command)
        conversation.addProbeResult(response.command, probeResult)
        continue

      case "command": {
        //if risk level is med or higher (configurable?) and not in yolo mode, confirm command first
        const action = await confirmCommand(response, params.mode)
        if (action.type === "cancel") return

        const cmd = action.type === "edited" ? action.editedCommand : response.command
        const result = await execute(cmd)
        if (result.exitCode === 0) return

        // On error on a user-edited commands: show error and stop. Do not attempt to fix with LLM
        if (action.type === "edited") return showError(result)

        // On error on LLM-generated commands: feed error back for auto-fix
        conversation.addError(cmd, result)
        continue
      }
    }
  }

  // TODO: define behavior when MAX_ROUNDS is exhausted.
  // Show accumulated errors? Last error only? A summary?
}
```

### Loop Rules

| Rule | Rationale |
|---|---|
| Unified counter for probes + retries | Simplicity. One budget prevents runaway loops regardless of response type. |
| Memory writes are immediate | A probe that discovers `shell=zsh` is useful even if the final command fails. Must also update the in-memory state used by the conversation so the next LLM call in the same loop sees the updated memory — not just persist to disk. |
| User-edited commands don't get auto-fix | The user took manual control. Don't second-guess their edit with LLM auto-fix. |
| Prompt structured as multi-turn conversation | Natural fit for chat APIs. Probes/errors become conversation turns, giving the LLM full context. |

---

## Proposed Module Structure

```
src/
  index.ts              Entry point. Imports main().
  main.ts               Top-level orchestration flow
  response.schema.ts    Zod schema for LLM responses (shared between core and providers)
  prompt.optimized.ts   Auto-generated system prompt (DSPy)

  core/
    query.ts            The query loop (runQuery)
    input.ts            CLI arg parsing, mode resolution
    parse-response.ts   LLM response JSON parsing + validation

  config/
    config.ts           Config loading, merging, validation
    config-wizard.ts    First-run setup TUI (reused by `wrap config` subcommand).
                        Lives here (not ui/) — its logic is config-specific (provider
                        selection, config file writing). It imports UI components from ui/.
    config.schema.json  JSON Schema for editor support

  providers/
    llm.ts              Provider dispatch (factory: config → LLM client)
    claude-code.ts      Claude CLI provider
    test.ts             Deterministic test provider

  ui/
    ...                 TUI components (confirmation panel, risk display, etc.)

  memory/
    memory.ts           Load, save, ensure

  threads/
    threads.ts          Load, save, TTL, thread linking
```

Runtime data lives in `~/.wrap/` (overridable via `WRAP_HOME`):
- `~/.wrap/config.jsonc` — user config
- `~/.wrap/memory.json` — memory facts (see specs/memory.md)
- `~/.wrap/threads/` — conversation history

---

## Subcommands

Detected by `parseInput()` before any ensure steps. Subcommands bypass the normal flow entirely:

```ts
if (input.subcommand) return runSubcommand(input.subcommand)
```

The config wizard is reusable — called by both `ensureConfig()` (first-run) and `wrap config` subcommands (manual reconfigure).

Note: subcommands may need their own prerequisites. `wrap config` reads existing config to reflect current values in the TUI (falling back to defaults if none exists). `wrap memory` would need config to know where `~/.wrap/` is. Subcommands call their own `ensure*` or `load*` functions internally rather than relying on the main flow's ensure steps.

---

## Mode

Mode is a simple string field (`"smart" | "yolo" | "force-cmd" | "force-answer" | "confirm-all"`) resolved from the invocation name (`w`, `wyolo`, etc. very TBD!) or flags. It's passed to `runQuery` and checked at decision points:

- **Confirmation:** yolo skips, confirm-all always shows, smart checks risk level
- **Response handling:** force-cmd / force-answer may constrain LLM behavior (feature out of current scope)

Implementation of modes is deferred. The architecture supports them as a parameter to the query loop.

---

## Design Decisions

### Why not pipeline/middleware?

Considered and rejected. Wrap has a fixed, small set of flows — the composability of a pipeline pattern doesn't pay for its costs (implicit ordering dependencies, shared mutable context bag with optional fields, indirection). Sequential code with good function decomposition is simpler, more explicit, and more testable.

### Why not hybrid resolve/execute?

A pure `resolve()` → `execute()` separation breaks down when flows continue after prerequisites. First-run setup creates config, then the query should proceed — not re-resolve. The ensure pattern handles this naturally: `ensureConfig()` returns and the next line runs.

---

## Notes

* Treat all code in this document as pseudo code. Actual code and even function signatures can change.

