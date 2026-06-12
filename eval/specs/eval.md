# Eval System

Wrap's prompt optimization pipeline. DSPy/GEPA discovers the best instruction text by evaluating candidates through a **Bun eval bridge** — a TypeScript subprocess that uses the same prompt assembly and LLM execution as runtime, guaranteeing parity between what's optimized and what ships.

> **Status:** Implemented

## Overview

The eval system has three layers:

1. **Python (DSPy/GEPA)** — drives the optimization loop. Evolves instruction text via reflective mutation (reflection LM analyzes failure traces and proposes targeted improvements), scores results, maintains a Pareto front of candidates.
2. **Bun eval bridge** (`eval/bridge.ts`) — a TypeScript subprocess that Python calls for each evaluation. Receives candidate instruction + example data via stdin, uses the same `formatContext` → `buildPromptScaffold` → LLM call path as runtime, returns validated response or classified error via stdout.
3. **Shared JSON artifacts** — two files that connect Python and TypeScript: static prompt constants (shared, committed) and optimization output (written by Python, read by TS at runtime).

Every candidate evaluation goes through the bridge, so the instruction is always tested against the real prompt shape. Reflection LM calls (instruction evolution) stay in DSPy — they're meta-level search operations that don't need runtime parity.

## Architecture

### Two shared JSON files

**`src/prompt.constants.json`** — static prompt strings. Checked into the repo. Both TS and Python read it. Neither language "owns" it — it's shared data.

Contains: section headers (`## System facts`, `## Facts about`, `## Attached input`, etc.), `fewShotSeparator`, `schemaInstruction`, `memoryRecencyInstruction`, `toolsScopeInstruction`, `voiceInstructions`, `pipedOutputInstruction`, `sectionUserRequest`. Probe state (cwd path, cwd files, tool watchlist) is no longer here — the discovery skill emits those as transcript turns.

**`src/prompt.optimized.json`** — optimization output. Python writes it after optimization. TS imports it at runtime.

Contains: `instruction` (winning instruction), `fewShotExamples` (always `[]` — GEPA is instruction-only), `schemaText` (extracted from .ts with comments), `promptHash` (SHA-256 covering both JSON files — computed once by Python during optimization, never at runtime).

**Why two files?** Constants are shared data that anyone can edit. Optimized data is produced by Python and consumed by TS. Separating them makes the ownership clear without either language "owning" the other's data. The constants change rarely and are committed to git. The optimized artifact changes every optimization run.

**Why not have one language own everything?** This was considered. Python ownership means Python defines constants that are really about TS prompt shape — TS loses control of its own runtime behavior. TS ownership means Python can't override constants during optimization and the JSON artifact is minimal. Two shared files avoid the ownership debate entirely: constants are just data, and the optimized artifact is just data.

### Key TypeScript functions

```
formatContext({memory, cwd, piped, attachedInput*, constants}) → string
  Pure function. Filters memory scopes by CWD prefix, sorts alphabetically,
  builds sections (## System facts, ## Facts about <path>, optional attached-
  input + piped-output instructions). Probe state (cwd path, cwd files, tool
  watchlist) is NOT here — the discovery skill emits those as transcript turns.

buildPromptScaffold(config, contextString, ...) → PromptScaffold
  Pure function. Assembles system message from config (instruction + schema +
  memory/voice instructions). Builds the few-shot prefix messages (pairs +
  separator) and carries contextString + sectionUserRequest for the turn
  framer, which wraps the first user turn at add time. No side effects.

assemblePromptScaffold(queryContext) → PromptScaffold
  Runtime wrapper. Reads both JSON files. Calls formatContext with runtime state
  (memory, cwd, piped). Calls buildPromptScaffold with config from JSON. This
  is what the session calls (see src/session/session.ts) — the public API for runtime prompt assembly.
```

**Why separate `formatContext` and `buildPromptScaffold`?** Each has one responsibility. `formatContext` converts raw data (memory dict, piped flag) into formatted text. `buildPromptScaffold` takes text pieces and structures them into a `PromptScaffold`. This separation makes each function simpler and independently testable. The bridge calls both in sequence; runtime does the same via the wrapper.

### Bridge protocol

One script: `eval/bridge.ts`. Reads JSON from stdin, writes JSON to stdout.

**Two modes:**
- `assemble` — build prompt only, return full `PromptInput` (useful for parity testing and inspection)
- `execute` — build prompt, call LLM once, return validated response

#### Input (stdin JSON, both modes):

```json
{
  "mode": "assemble",
  "instruction": "You are a CLI tool that translates...",
  "fewShotExamples": [{"input": "...", "output": "..."}],
  "schemaText": "const CommandResponseSchema = z.object({...})",
  "memory": {"/": [{"fact": "Runs macOS on arm64"}]},
  "cwd": "/Users/tal/project",
  "piped": false,
  "query": "find all typescript files",
  "extraMessages": [
    {"role": "assistant", "content": "{\"type\":\"command\",\"final\":false,\"content\":\"which brew curl git docker || true\",\"risk_level\":\"low\"}"},
    {"role": "user", "content": "## Captured output\n/opt/homebrew/bin/brew\n/usr/bin/curl\n/usr/bin/git\n"}
  ]
}
```

Probe state (tools availability, cwd listing) flows via `extraMessages` as transcript turns mimicking what the discovery skill emits at runtime. Top-level `tools` / `cwdFiles` fields are no longer accepted.

The bridge reads `src/prompt.constants.json` internally for section headers and fixed instructions. Python only sends candidate-specific data (instruction, demos, schemaText) and example-specific data (memory, cwd, query, piped, extraMessages).

**Why Python sends schemaText instead of bridge reading it?** The schema text is extracted from `src/command-response.schema.ts` by Python's `read_schema.py` (regex between markers). This preserves the field comments that are critical LLM context. Python already does this extraction; it passes the result to the bridge and also writes it to `prompt.optimized.json` for runtime.

#### Output — assemble mode:

```json
{
  "ok": true,
  "promptInput": {
    "system": "You are a CLI tool...\n\nRespond with a JSON object...\n\n...",
    "messages": [
      {"role": "user", "content": "remove all node_modules..."},
      {"role": "assistant", "content": "{...}"},
      {"role": "user", "content": "Now handle the following request."},
      {"role": "user", "content": "## System facts\n- Runs macOS on arm64\n\n...## User's request\nfind all typescript files"}
    ]
  }
}
```

#### Output — execute mode (success):

```json
{
  "ok": true,
  "response": {
    "type": "command",
    "content": "find . -name '*.ts'",
    "risk_level": "low",
    "explanation": "Recursively find all TypeScript files"
  }
}
```

#### Output — execute mode (failure):

Three distinct error types, each with different semantics for the optimizer:

```json
{"ok": false, "error": "invalid_json", "rawText": "Sure! Here is the command...", "message": "Unexpected token at position 0"}
```
LLM produced non-JSON output. Signals the candidate instruction failed to constrain the model's output format. **Score as 0.**

```json
{"ok": false, "error": "invalid_schema", "rawText": "{\"type\":\"cmd\",...}", "message": "type must be command|probe|answer"}
```
LLM produced valid JSON but it doesn't match CommandResponseSchema. Signals the instruction gave the model a wrong understanding of the schema. **Score as 0.**

```json
{"ok": false, "error": "provider_error", "message": "429 rate limit exceeded"}
```
Network, auth, or provider failure. Not the instruction's fault. **Scores as 0.0** (returning None from DSPy metrics is unreliable). Logged separately for post-hoc analysis — if many calls fail with `provider_error`, the problem is infrastructure, not the instruction.

**Why three error types?** A `provider_error` (network blip) is fundamentally different from `invalid_json` (instruction quality issue). Collapsing them into one type loses signal. `invalid_json` vs `invalid_schema` is a further useful distinction: the former means the model ignored JSON formatting entirely, the latter means it tried but misunderstood the schema. The granularity costs nothing and lets Python make better scoring decisions.

#### Fatal errors:

Non-zero exit code + stderr for truly fatal issues (missing dependencies, bridge script crash). These are bugs, not expected failures. Python should halt the optimization run.

### Provider config

The bridge uses the existing `WRAP_CONFIG` environment variable. Docker sets this with eval-specific provider config:

```bash
WRAP_CONFIG='{"providers":{"anthropic":{"model":"claude-sonnet-4-6","apiKey":"$ANTHROPIC_API_KEY"}},"defaultProvider":"anthropic"}'
```

The bridge calls `loadConfig()` → `resolveProvider()` → `initLlm()` using the existing config loading path. No new config code.

**Why not pass provider config per request?** WRAP_CONFIG reuses existing infrastructure. The provider stays the same for the entire optimization run. Sending API key on every subprocess call (hundreds of times) is unnecessary. WRAP_CONFIG is set once in the Docker environment.

**Why not use the user's local Wrap config?** Eval runs in Docker with different credentials and models than the user's runtime. Reading `~/.wrap/config.jsonc` would be wrong and non-reproducible.

### Optimization flow

```
OPTIMIZATION START
   │
   │  Python loads ~134 examples from seed.jsonl
   │  Python extracts schemaText from command-response.schema.ts
   │  Python reads prompt.constants.json for fixed strings
   │
   ▼
GEPA OPTIMIZATION (~900 metric calls for medium budget)
   │
   │  Initial full eval on valset establishes baseline
   │  GEPA iterates: subsample → evaluate → reflect → propose mutation
   │
   │  For each candidate × each sampled example:
   │    GEPA calls WrapPredictor.forward(memory, cwd, piped, extra_messages, query, ...)
   │    → forward() reads candidate instruction from self.predict.signature.instructions
   │    → sends to eval/bridge.ts (execute mode) via subprocess (with diskcache)
   │    → bridge builds prompt, calls LLM, validates with Zod
   │    → returns {ok: true, response: {...}} or {ok: false, error: "...", ...}
   │    → Python metric returns ScoreWithFeedback (score + assertion failure explanation)
   │
   │  Reflection LM analyzes failure feedback, proposes targeted instruction changes
   │  Pareto front tracks best candidates across all examples
   │  Bridge-level diskcache avoids redundant LLM calls across iterations
   │  16 parallel threads for bridge subprocess calls
   │
   ▼
FINAL EVAL (bridge calls on train + val sets)
   │  Custom bridge eval loop
   │  Reports aggregate scores
   │
   ▼
WRITE OUTPUT
   │  Python writes src/prompt.optimized.json:
   │    {instruction, fewShotExamples: [], schemaText, promptHash}
   │
   ▼
DONE
```

### Runtime flow

```
User: w find all typescript files
   │
   ▼
loadConfig() → resolveProvider() → initLlm()
ensureMemory()
runSkills() → emits transcript turns (discovery: pwd / ls / which; commit: status / diffs)
   │
   ▼
assemblePromptScaffold(queryContext)
   │  imports prompt.constants.json (section headers, fixed instructions)
   │  imports prompt.optimized.json (instruction, demos, schemaText)
   │  calls formatContext({memory, cwd, piped, ...}) → contextString
   │  calls buildPromptScaffold(config, contextString, ...) → PromptScaffold
   │
   ▼
conversation.send(CommandResponseSchema)
   │  turns are framed into the conversation as they happen (add-time framing)
   │  core retries once inside send on structured-output failure
   │  (runtime-only policy — the bridge always sends with retry: false)
   │
   ▼
Process response (execute command / print answer / save memory)
```

### Why every eval goes through the bridge

An alternative would be letting DSPy evaluate candidates through its own LM and only using the bridge for a final validation pass. The problem: DSPy's internal prompt formatting wraps fields in its own template (`dspy.Predict` adds field descriptions, formatting markers, etc.), so the candidate instruction would be tested against DSPy's prompt shape, not Wrap's — and might perform differently in production.

Instead, `WrapPredictor.forward()` calls the bridge for every evaluation. GEPA manages candidates (instruction text), but every scoring call goes through the bridge — which uses `buildPromptScaffold` (Wrap's real prompt assembly). No double LLM calls: the bridge call replaces DSPy's LM call, not adds to it.

**Overhead**: ~50-100ms Bun subprocess startup per call, mitigated by bridge-level diskcache (same instruction + example = cache hit). Full optimization run is ~25 minutes for medium budget (dominated by LLM latency). Net subprocess overhead: negligible.

**Reflection LM calls stay in DSPy**: GEPA's reflection model (Claude Opus) analyzes failure traces and proposes instruction mutations through DSPy's own LM abstraction. These are meta-level search operations — the reflection model reads what went wrong and suggests fixes, it doesn't need to go through the bridge. Only evaluation of candidates goes through the bridge.


## Decisions and reasoning summary

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Bridge model | Per-call subprocess (v1) | Bun startup ~50-100ms, negligible vs LLM latency. Simpler than long-running server. Can evolve to server later. |
| Bridge replaces DSPy's eval LLM | Yes, all eval goes through bridge | Full parity. Winning instruction tested against real prompt shape. No "hope it transfers" gap. Same number of LLM calls (replace, not add). |
| Bridge retry | No retry | Malformed output is optimization signal. Retry masks instruction quality differences. |
| Prompt constants | Shared `prompt.constants.json` | Neither language owns them. Just shared data. Change once, both sides see it. |
| Optimized artifact | JSON (`prompt.optimized.json`) | Data, not code. Python shouldn't generate TypeScript source. Bun imports JSON natively. |
| Schema text | Python extracts, passes to bridge + writes to optimized JSON | Preserves field comments (critical LLM context). read_schema.py proven mechanism. |
| Provider config | WRAP_CONFIG env var | Reuses existing config loading. Set once per Docker run. Eval-specific credentials. |
| Bridge modes | One script, `assemble` + `execute` | `assemble` enables parity testing. `execute` is the eval path. One entry point. |
| Error granularity | `invalid_json`, `invalid_schema`, `provider_error` as distinct types | Provider errors (network) shouldn't penalize instruction quality. JSON vs schema errors are different failure modes. Free signal, zero cost. |
| Error channels | Structured JSON for expected errors, non-zero exit for fatal | Expected failures (validation, provider) return JSON. Bridge crashes exit non-zero. Two channels, each appropriate. |
| TS refactor shape | `formatContext` + `buildPromptScaffold` + `assemblePromptScaffold` wrapper | Each function has one job. Pure core is injectable. Wrapper preserves runtime ergonomics. |
| Docker setup | Multi-stage (Bun + Python) | Hermetic. Linux binaries built in Docker. No host platform leakage. |
| Post-optimization eval | Custom bridge eval loop | Direct measurement of bridge-scored performance. Full control. Not coupled to DSPy's Evaluate. |
| Metric adaptation | `ScoreWithFeedback` wrapping `score(dict)` | Bridge validates; metric scores and explains failures for GEPA reflection. |
| Prompt hash | Computed once by Python, covers both JSON files | Hash versions the full prompt surface (constants + optimized data). Never recomputed at runtime. Read-only for logging/caching. |
| Optimizer | GEPA (instruction-only, reflective evolution) | +10% over MIPROv2 at same budget. Few-shot demos were never produced by prior MIPROv2 runs — dead weight eliminated. |
| Bridge caching | diskcache (deterministic hash → disk) | Same (instruction, example) pair = cache hit. Crash recovery + re-run speedup. Docker named volume persists across runs. |
| Parallelism | 16 threads (configurable via NUM_THREADS) | Bridge subprocess calls release the GIL → true parallelism. ~10x speedup on eval phase. |
| Metric feedback | ScoreWithFeedback (score + assertion failure text) | GEPA's reflective mutation reads failure explanations. More targeted than generic "score was 0.45". |
| Trace registration | Manual `dspy.settings.trace.append()` in forward() | GEPA needs trace entries to match predictions to predictors. forward() bypasses self.predict(), so traces are registered manually — same format as Predict.__call__(). |
| Temperature workaround | `additional_drop_params=["temperature"]` on reflection LM | Claude Opus 4.7 rejects temperature. LiteLLM bug #26444 (still open). Workaround strips the param before the API call. |

## Risks and notes

### DSPy compatibility with custom `forward()`

`WrapPredictor.forward()` bypasses DSPy's internal `Predict` module. GEPA manages `self.predict.signature.instructions` — `forward()` reads this dynamically. Trace entries are manually appended via `dspy.settings.trace.append((self.predict, kwargs, prediction))` so GEPA's reflective dataset builder can map predictions to predictors.

### Prompt hash

`promptHash` is a SHA-256 hash covering the full prompt surface: all fields from both `prompt.constants.json` and `prompt.optimized.json`. Python computes it once at the end of optimization. Runtime reads the hash for logging/cache-invalidation purposes but never recomputes it.

### DSPy signature field changes

DSPy Examples store raw data (memory dict, cwd, piped, extra_messages) instead of pre-formatted `memory_context` string. Probe state (tools availability, cwd listing) lives in `extra_messages` as transcript turns mimicking discovery-skill output. GEPA's reflection model sees raw JSON when analyzing failure traces. Reflection model is Claude Opus — it handles JSON well.

### LLM-as-judge for context-sensitive samples (not yet implemented)

Some eval samples can't be scored with pattern matching alone. When the correct response depends on how the LLM interprets context, multiple response types may be valid — but only if the response acknowledges the context appropriately. Regex can't distinguish intent.

**Example:** tools_output says `docker not found`, user asks "show running docker containers."

- Good: `command` with `docker ps 2>&1 || echo 'Docker not installed'` — tries the command, handles failure gracefully in one shot.
- Good: `probe` with `docker ps 2>&1` — checks availability, LLM can give an intelligent follow-up.
- Bad: `command` with `docker ps` — ignores the "not found" context, will just fail.

Pattern matching can't distinguish the good command from the bad one — both match `docker.*ps`. A targeted LLM-as-judge could: an optional `judge_prompt` field in assertions that sends the response + context to a scoring LLM. Most samples keep fast pattern matching; only samples with this kind of ambiguity opt in.

## Assumptions

- **Bridge is per-call subprocess with diskcache.** Subprocess overhead is negligible; cache eliminates redundant LLM calls.
- **Eval bridge never retries.** Malformed output is optimization signal, not something to repair.
- **Static constants live in a shared JSON file.** Neither language owns them. Changed by hand, committed to git.
- **Python owns optimized instruction data and writes the artifact.** Few-shot examples are always `[]` (GEPA is instruction-only).
- **Provider config for eval is always explicit and Docker-local.** Eval must not depend on user Wrap runtime config.
- **Bridge protocol is stdin/stdout JSON.** Designed so it can later become a long-lived worker with the same request/response shape.
