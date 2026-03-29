# Bun Eval Bridge — Spec

Wrap is a CLI tool that translates natural language into shell commands (e.g., `w find all typescript files` → `find . -name '*.ts'`). It's built in TypeScript/Bun, with a Python/DSPy pipeline that optimizes the system prompt offline.

## Problem

Wrap has two independent implementations of prompt assembly and LLM execution:

1. **TypeScript runtime** (`src/llm/context.ts`): assembles prompts from system prompt + memory + tools + query, calls LLM via AI SDK provider.
2. **Python eval/optimizer** (`eval/dspy/optimize.py`): duplicates prompt assembly logic (`memory_to_context()`, section headers, instruction constants), calls LLM via DSPy's own abstraction.

This causes:
- **Duplicated logic**: Memory filtering (CWD prefix match), context section assembly, and prompt constants are implemented independently in both languages.
- **Parity gap**: DSPy's MIPRO optimizer evaluates candidate instructions using DSPy's own prompt formatting, then deploys the winner into Wrap's different prompt structure. The instruction may not transfer perfectly.
- **Maintenance burden**: Any change to prompt assembly must be made in two places. Drift is inevitable.

## Solution

A **Bun eval bridge**: a single TypeScript script (`eval/bridge.ts`) that Python calls as a subprocess during optimization. The bridge lets DSPy use the same prompt assembly and LLM execution machinery as runtime, eliminating duplication and guaranteeing parity.

### What changes

| Concern | Before | After |
|---------|--------|-------|
| Prompt assembly during eval | Duplicated in Python + TS | TS only (via bridge) |
| LLM execution during eval | DSPy's LM abstraction | AI SDK provider (via bridge) |
| Memory context formatting | Python `memory_to_context()` | TS `formatContext()` (via bridge) |
| Static prompt constants | Defined in Python `optimize.py`, exported to `.ts` | Shared `prompt.constants.json`, read by both |
| Optimized prompt config | `prompt.optimized.ts` (generated TS source) | `prompt.optimized.json` (JSON, written by Python) |
| Scoring | `metric.score()` parses raw text + validates | Bridge validates with Zod; `metric.score()` receives validated dict |

### What stays the same

- DSPy/MIPRO still drives optimization search (instruction proposal, demo bootstrapping via teacher model)
- Python still owns the optimization loop and writes the optimized artifact
- `read_schema.py` still extracts Zod schema text (with field comments) from the `.ts` file
- Eval examples format (`seed.jsonl`) unchanged
- Runtime behavior unchanged (same prompts, same execution)

## Architecture

### Two shared JSON files

**`src/prompt.constants.json`** — static prompt strings. Checked into the repo. Both TS and Python read it. Neither language "owns" it — it's shared data.

Contains: section headers (`## System facts`, `## Facts about`, etc.), `cwdPrefix`, `fewShotSeparator`, `schemaInstruction`, `memoryRecencyInstruction`, `toolsScopeInstruction`, `voiceInstructions`, `pipedOutputInstruction`, `sectionUserRequest`.

**`src/prompt.optimized.json`** — optimization output. Python writes it after optimization. TS imports it at runtime.

Contains: `instruction` (winning instruction), `fewShotExamples` (winning demos), `schemaText` (extracted from .ts with comments), `promptHash` (SHA-256 covering both JSON files — computed once by Python during optimization, never at runtime).

**Why two files?** Constants are shared data that anyone can edit. Optimized data is produced by Python and consumed by TS. Separating them makes the ownership clear without either language "owning" the other's data. The constants change rarely and are committed to git. The optimized artifact changes every optimization run.

**Why not have one language own everything?** This was considered. Python ownership means Python defines constants that are really about TS prompt shape — TS loses control of its own runtime behavior. TS ownership means Python can't override constants during optimization and the JSON artifact is minimal. Two shared files avoid the ownership debate entirely: constants are just data, and the optimized artifact is just data.

### Key TypeScript functions

```
formatContext(memory, tools, cwd, piped, constants) → string
  Pure function. Filters memory scopes by CWD prefix, sorts alphabetically,
  builds sections (## System facts, ## Facts about <path>, ## Detected tools,
  piped instruction, CWD line). Uses section header strings from constants param.

buildPrompt(config, contextString, query) → PromptInput
  Pure function. Assembles system message from config (instruction + schema +
  memory/tools/voice instructions). Builds messages array (few-shot pairs,
  separator, user message with context + query). No side effects.

assembleCommandPrompt(queryContext) → PromptInput
  Runtime wrapper. Reads both JSON files. Calls formatContext with runtime state
  (memory, tools, cwd). Calls buildPrompt with config from JSON. This is what
  query.ts calls — the public API for runtime prompt assembly.
```

**Why separate `formatContext` and `buildPrompt`?** Each has one responsibility. `formatContext` converts raw data (memory dict, tools string) into formatted text. `buildPrompt` takes text pieces and structures them into a `PromptInput`. This separation makes each function simpler and independently testable. The bridge calls both in sequence; runtime does the same via the wrapper.

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
  "toolsOutput": "/opt/homebrew/bin/git\n/opt/homebrew/bin/bun",
  "cwd": "/Users/tal/project",
  "piped": false,
  "query": "find all typescript files"
}
```

The bridge reads `src/prompt.constants.json` internally for section headers and fixed instructions. Python only sends candidate-specific data (instruction, demos, schemaText) and example-specific data (memory, tools, cwd, query, piped).

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
WRAP_CONFIG='{"provider":{"type":"anthropic","model":"claude-haiku-4-5-20251001","apiKey":"$ANTHROPIC_API_KEY"}}'
```

The bridge calls `loadConfig()` → `initProvider()` using the existing config loading path. No new config code.

**Why not pass provider config per request?** WRAP_CONFIG reuses existing infrastructure. The provider stays the same for the entire optimization run. Sending API key on every subprocess call (hundreds of times) is unnecessary. WRAP_CONFIG is set once in the Docker environment.

**Why not use the user's local Wrap config?** Eval runs in Docker with different credentials and models than the user's runtime. Reading `~/.wrap/config.jsonc` would be wrong and non-reproducible.

### Optimization flow

```
OPTIMIZATION START
   │
   │  Python loads 56 examples from seed.jsonl
   │  Python extracts schemaText from command-response.schema.ts
   │  Python reads prompt.constants.json for fixed strings
   │
   ▼
MIPRO OPTIMIZATION (~400 subprocess calls, each with LLM)
   │
   │  MIPRO proposes candidate instruction text (via teacher LM — stays in DSPy)
   │  MIPRO bootstraps demo examples (via teacher LM — stays in DSPy)
   │
   │  For each candidate × each training example:
   │    MIPRO calls WrapPredictor.forward(memory, tools, cwd, piped, query)
   │    → forward() reads candidate instruction + demos from self.predict
   │    → sends to eval/bridge.ts (execute mode) via subprocess:
   │        {mode: "execute", instruction, demos, schemaText, memory, tools, cwd, piped, query}
   │    → bridge reads prompt.constants.json
   │    → bridge calls formatContext(memory, tools, cwd, piped, constants) → contextString
   │    → bridge calls buildPrompt(config, contextString, query) → PromptInput
   │    → bridge calls AI SDK provider with PromptInput
   │    → bridge validates response with Zod
   │    → returns {ok: true, response: {...}} or {ok: false, error: "validation_error", ...}
   │    → Python metric.score(response_dict, assertions) → float
   │
   │  MIPRO selects best candidate by aggregate score
   │
   ▼
FINAL EVAL (~16 bridge calls on validation set)
   │  Custom eval loop (not dspy.Evaluate)
   │  Same bridge flow as above
   │  Reports aggregate score
   │
   ▼
WRITE OUTPUT
   │  Python writes src/prompt.optimized.json:
   │    {instruction, fewShotExamples, schemaText, promptHash}
   │
   ▼
DONE
```

### Runtime flow

```
User: w find all typescript files
   │
   ▼
loadConfig() → initProvider()
probeTools() → ensureMemory()
   │
   ▼
assembleCommandPrompt(queryContext)
   │  imports prompt.constants.json (section headers, fixed instructions)
   │  imports prompt.optimized.json (instruction, demos, schemaText)
   │  calls formatContext(memory, tools, cwd, piped, constants) → contextString
   │  calls buildPrompt(config, contextString, query) → PromptInput
   │
   ▼
callWithRetry(provider, promptInput)
   │  calls provider.runPrompt once
   │  retries once on structured output failure (runtime-only policy)
   │
   ▼
Process response (execute command / print answer / save memory)
```

### Why bridge replaces DSPy's LLM call (not adds to it)

Previously considered: DSPy evaluates candidates through its own LM, and the bridge is only used for a final eval pass. This would mean MIPRO optimizes against DSPy's prompt formatting (different from runtime), then we verify the winner with the bridge.

The problem: DSPy's internal prompt formatting wraps fields in its own template (`dspy.Predict` adds field descriptions, formatting markers, etc.). The candidate instruction is tested against DSPy's prompt shape, not Wrap's. The instruction might perform differently in Wrap's actual structure.

The solution: `WrapPredictor.forward()` calls the bridge instead of `self.predict()`. MIPRO still manages candidates (instruction text, demos), but every evaluation goes through the bridge — which uses `buildPrompt` (Wrap's real prompt assembly). No double LLM calls: the bridge call replaces DSPy's LM call.

**Overhead**: ~50-100ms Bun subprocess startup per call. ~400 calls × 75ms = ~30 seconds. Full optimization run is ~30-60 minutes (dominated by LLM latency). Net overhead: ~1-2%. Acceptable.

**Teacher model calls stay in DSPy**: MIPRO's teacher proposes instruction candidates and bootstraps demos through DSPy's own LM abstraction. These are meta-level search operations — the teacher generates ideas for the target model, it doesn't need to go through the bridge. Only evaluation of candidates goes through the bridge.

## Implementation steps

### Step 1: TS refactor + JSON artifact switch

**Standalone value**: Cleaner separation of concerns in TypeScript. Pure, injectable prompt assembly. Shared JSON constants instead of generated TypeScript source. Improves code quality independent of the bridge.

This step touches both TypeScript and Python (combined change) because the JSON artifact is written by Python and read by TypeScript — changing one side without the other leaves a broken state. Doing both together ensures the pipeline works end-to-end.

#### 1a. Create `src/prompt.constants.json`

Manually create this file once by extracting the static prompt strings currently defined in Python's `optimize.py`. This file is committed to git and maintained by hand going forward — it changes rarely (only when prompt structure changes, not during optimization). Both TS and Python read it; neither generates it.

```json
{
  "sectionSystemFacts": "## System facts",
  "sectionFactsAbout": "## Facts about",
  "sectionDetectedTools": "## Detected tools",
  "sectionUserRequest": "## User's request",
  "cwdPrefix": "- Working directory (cwd):",
  "fewShotSeparator": "Now handle the following request.",
  "schemaInstruction": "Respond with a JSON object conforming to this schema:",
  "memoryRecencyInstruction": "Later facts override earlier ones...",
  "toolsScopeInstruction": "Listed tools aren't exhaustive...",
  "voiceInstructions": "Response voice guidelines...",
  "pipedOutputInstruction": "stdout is piped to another program..."
}
```

#### 1b. Extract `formatContext` from `context.ts`

New file: `src/llm/format-context.ts`

```typescript
export type FormatContextParams = {
  memory: Memory;
  toolsOutput?: string;
  cwd: string;
  piped?: boolean;
  constants: {
    sectionSystemFacts: string;
    sectionFactsAbout: string;
    sectionDetectedTools: string;
    cwdPrefix: string;
    pipedOutputInstruction: string;
  };
};

export function formatContext(params: FormatContextParams): string
```

Contains: memory scope filtering by CWD prefix match, alphabetical scope sorting, section header formatting, fact bullet formatting, tools section, piped instruction, CWD line. All extracted from the current `assembleCommandPrompt`.

#### 1c. Extract `buildPrompt` from `context.ts`

New file: `src/llm/build-prompt.ts`

```typescript
export type PromptConfig = {
  instruction: string;
  schemaInstruction: string;
  schemaText: string;
  memoryRecencyInstruction: string;
  toolsScopeInstruction: string;
  voiceInstructions: string;
  fewShotExamples: Array<{ input: string; output: string }>;
  fewShotSeparator: string;
  sectionUserRequest: string;
};

export function buildPrompt(
  config: PromptConfig,
  contextString: string,
  query: string,
): PromptInput
```

Assembles:
- **System message**: config.instruction + config.memoryRecencyInstruction + config.toolsScopeInstruction + config.voiceInstructions + config.schemaInstruction + config.schemaText
- **Messages array**: few-shot pairs (user/assistant) + separator message + final user message (contextString + "## User's request\n" + query)

Pure function. No file reads, no imports from JSON files, no side effects.

#### 1d. Refactor `assembleCommandPrompt` as thin wrapper

`src/llm/context.ts` becomes:

```typescript
import promptConstants from '../prompt.constants.json';
import promptOptimized from '../prompt.optimized.json';
import { formatContext } from './format-context';
import { buildPrompt } from './build-prompt';

export function assembleCommandPrompt(ctx: QueryContext): PromptInput {
  const contextString = formatContext({
    memory: ctx.memory,
    toolsOutput: ctx.toolsOutput,
    cwd: ctx.cwd,
    piped: ctx.piped,
    constants: promptConstants,
  });

  return buildPrompt(
    {
      instruction: promptOptimized.instruction,
      schemaInstruction: promptConstants.schemaInstruction,
      schemaText: promptOptimized.schemaText,
      memoryRecencyInstruction: promptConstants.memoryRecencyInstruction,
      toolsScopeInstruction: promptConstants.toolsScopeInstruction,
      voiceInstructions: promptConstants.voiceInstructions,
      fewShotExamples: promptOptimized.fewShotExamples,
      fewShotSeparator: promptConstants.fewShotSeparator,
      sectionUserRequest: promptConstants.sectionUserRequest,
    },
    contextString,
    ctx.prompt,
  );
}
```

#### 1e. Update Python optimizer to write JSON

Modify `optimize.py`'s `write_output()` to write `src/prompt.optimized.json` instead of `src/prompt.optimized.ts`:

```python
def write_output(instruction, demos, schema_text, prompt_hash):
    output = {
        "instruction": instruction,
        "fewShotExamples": [
            {"input": d["input"], "output": d["output"]}
            for d in demos
        ],
        "schemaText": schema_text,
        "promptHash": prompt_hash,
    }
    with open("/app/src/prompt.optimized.json", "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
```

Remove: the `prompt.optimized.ts` generation code (backtick escaping, TypeScript source formatting).

Delete: `src/prompt.optimized.ts`.

Remove inline constant definitions from `optimize.py` and replace with a JSON load:

```python
import json
with open("/app/src/prompt.constants.json") as f:
    CONSTANTS = json.load(f)
```

All existing references (e.g., `VOICE_INSTRUCTIONS`) become `CONSTANTS["voiceInstructions"]`. This is a pure refactor — Python reads the same values from the shared JSON file instead of defining them inline. `WrapPredictor.forward()` continues to work as before, appending these constants to the signature. The constants are deleted from `optimize.py` source but still accessible via the JSON load.

#### 1f. Update tests

- Existing `context.test.ts` updated for new function signatures
- New unit tests for `formatContext` (memory filtering, section assembly, edge cases)
- New unit tests for `buildPrompt` (system message composition, message array structure)
- Verify JSON import works correctly in compiled binary context
- Parity test: `assembleCommandPrompt` produces identical output before and after refactor

---

### Step 2: Bridge script

Add `eval/bridge.ts` with JSON-over-stdin / JSON-over-stdout protocol.

#### Bridge implementation

```typescript
// eval/bridge.ts
import { formatContext } from '../src/llm/format-context';
import { buildPrompt } from '../src/llm/build-prompt';
import { loadConfig } from '../src/config/config';
import { initProvider } from '../src/llm/index';
import { CommandResponseSchema } from '../src/command-response.schema';
import promptConstants from '../src/prompt.constants.json';

// Read stdin
const input = JSON.parse(await Bun.stdin.text());

// Format context from raw example data
const contextString = formatContext({
  memory: input.memory,
  toolsOutput: input.toolsOutput,
  cwd: input.cwd,
  piped: input.piped,
  constants: promptConstants,
});

// Build prompt
const promptInput = buildPrompt(
  {
    instruction: input.instruction,
    schemaText: input.schemaText,
    schemaInstruction: promptConstants.schemaInstruction,
    memoryRecencyInstruction: promptConstants.memoryRecencyInstruction,
    toolsScopeInstruction: promptConstants.toolsScopeInstruction,
    voiceInstructions: promptConstants.voiceInstructions,
    fewShotExamples: input.fewShotExamples,
    fewShotSeparator: promptConstants.fewShotSeparator,
    sectionUserRequest: promptConstants.sectionUserRequest,
  },
  contextString,
  input.query,
);

if (input.mode === 'assemble') {
  console.log(JSON.stringify({ ok: true, promptInput }));
  process.exit(0);
}

// Execute mode: call LLM once (no retry)
const config = loadConfig();
const provider = initProvider(config.provider);

try {
  const response = await provider.runPrompt(promptInput, CommandResponseSchema);
  console.log(JSON.stringify({ ok: true, response }));
} catch (error) {
  // Classify error for Python scoring.
  // AI SDK throws NoObjectGeneratedError with a .text property for LLM output.
  // Network/auth errors are plain Error instances without .text.
  const rawText = 'text' in error ? (error as any).text : undefined;
  const isProvider = !rawText && !(error instanceof SyntaxError);

  if (isProvider) {
    console.log(JSON.stringify({ ok: false, error: 'provider_error', message: String(error) }));
  } else if (rawText && !tryParseJson(rawText)) {
    console.log(JSON.stringify({ ok: false, error: 'invalid_json', rawText, message: String(error) }));
  } else {
    console.log(JSON.stringify({ ok: false, error: 'invalid_schema', rawText, message: String(error) }));
  }
}
```

**No retry**: Single LLM attempt. If the response fails Zod validation, return `{ok: false}`. MIPRO needs clean signal about which candidate instructions produce valid JSON.

**Why no retry in bridge?** Runtime does a round retry on structured output failure (appends the broken response + "respond only with valid JSON" and retries). During optimization, retrying would mask formatting issues. If a candidate instruction causes 30% of responses to be malformed JSON, MIPRO should see that as a lower score, not have the retry paper over it. This gives the optimizer better signal for selecting instructions that reliably produce well-structured output.

#### Bridge location

`eval/bridge.ts` lives in `eval/` alongside the Python code that calls it. It's eval-specific tooling, not runtime code. It imports from `../src/` using relative paths (Bun resolves these). It won't accidentally end up in the compiled binary since it's outside `src/`.

---

### Step 3: Python changes

#### 3a. `WrapPredictor.forward()` calls bridge

```python
class WrapPredictor(dspy.Module):
    def __init__(self, signature, constants, schema_text):
        self.predict = dspy.Predict(signature)
        self.constants = constants  # not used for prompt assembly, but for passing to bridge
        self.schema_text = schema_text

    def forward(self, **kwargs):
        # Read current candidate instruction + demos from DSPy's state
        instruction = self.predict.signature.instructions
        demos = [
            {"input": d.natural_language_query, "output": d.response_json}
            for d in (self.predict.demos or [])
        ]

        response, error_type = call_bridge_execute(
            instruction=instruction,
            demos=demos,
            schema_text=self.schema_text,
            memory=kwargs['memory'],
            tools_output=kwargs['tools_output'],
            cwd=kwargs['cwd'],
            piped=kwargs.get('piped', False),
            query=kwargs['natural_language_query'],
        )

        # response_json must be a JSON string (not dict) because:
        # 1. DSPy signature declares it as str output field
        # 2. MIPRO stores successful predictions as demos — demo.response_json
        #    is read back as a string when building few-shot examples for the bridge
        return dspy.Prediction(
            response_json=json.dumps(response) if response else None,
            response_dict=response,       # dict for metric scoring (avoids re-parsing)
            error_type=error_type,         # None on success, error string on failure
        )
```

**Key insight**: MIPRO modifies `self.predict.signature.instructions` and `self.predict.demos` before each evaluation call. The `forward()` method reads these dynamically, so each evaluation uses the current candidate instruction + demos being tested.

#### 3b. Bridge subprocess helper

```python
import subprocess, json

def call_bridge(mode, instruction, demos, schema_text, memory, tools_output, cwd, piped, query):
    payload = json.dumps({
        "mode": mode,
        "instruction": instruction,
        "fewShotExamples": demos,
        "schemaText": schema_text,
        "memory": memory,
        "toolsOutput": tools_output,
        "cwd": cwd,
        "piped": piped,
        "query": query,
    })
    try:
        result = subprocess.run(
            ["bun", "run", "/app/eval/bridge.ts"],
            input=payload, capture_output=True, text=True,
            timeout=120,  # seconds — prevents silent hangs on LLM stalls
        )
    except subprocess.TimeoutExpired:
        print("Bridge call timed out (120s)", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(f"Bridge error: {result.stderr}", file=sys.stderr)
        return None
    return json.loads(result.stdout)

def call_bridge_execute(**kwargs):
    """Returns (response_dict, error_type) tuple.
    On success: (dict, None). On failure: (None, error_type_string).
    error_type is one of: 'invalid_json', 'invalid_schema', 'provider_error', 'bridge_crash'.
    """
    result = call_bridge(mode="execute", **kwargs)
    if result is None:
        return None, "bridge_crash"
    if not result.get("ok"):
        return None, result.get("error", "unknown")
    return result["response"], None
```

#### 3c. DSPy example conversion

Examples in `seed.jsonl` store raw data (memory dict, tools, cwd, piped, query). The conversion to DSPy Examples now passes raw fields instead of pre-formatted context:

```python
def examples_to_dspy(raw_examples):
    """Convert raw JSONL examples to DSPy Examples with defaults.

    Memory merge logic (matches current behavior):
    - If example has no "memory" key: use DEFAULT_MEMORY (full default system facts)
    - If example has "memory" with a "/" scope: use as-is (example controls system facts)
    - If example has "memory" without "/" scope: merge DEFAULT_MEMORY["/"] as system facts
    - To explicitly test with NO system facts: set "/" to empty list: {"memory": {"/": []}}
    """
    examples = []
    for ex in raw_examples:
        memory = ex.get("memory")
        if memory is None:
            memory = DEFAULT_MEMORY
        elif "/" not in memory:
            # Example has project-scoped memory but no system facts — merge defaults
            memory = {"/": DEFAULT_MEMORY["/"], **memory}

        examples.append(dspy.Example(
            memory=memory,
            tools_output=ex.get("tools_output", DEFAULT_TOOLS_OUTPUT),
            cwd=ex.get("cwd", DEFAULT_CWD),
            piped=ex.get("piped", False),
            natural_language_query=ex["input"],
            assertions=ex["assertions"],
        ).with_inputs("memory", "tools_output", "cwd", "piped", "natural_language_query"))
    return examples
```

#### 3d. Simplify `metric.py`

With the bridge doing Zod validation and returning typed errors, the metric handles three cases:

```python
def wrap_metric(example, prediction, trace=None):
    """MIPRO metric function. Handles bridge error types."""
    error_type = getattr(prediction, 'error_type', None)

    if error_type is not None:
        # All errors score as 0.0. provider_error is logged separately for
        # post-hoc analysis, but still scores 0 — returning None from a DSPy
        # metric is not reliably supported across versions.
        return 0.0

    return score(prediction.response_dict, example.assertions)


def score(response: dict, assertions: dict) -> float:
    """Score a validated response against assertions. Returns 0.0-1.0."""
    checks = []
    weights = []

    if "type" in assertions:
        checks.append(response["type"] == assertions["type"])
        weights.append(3.0)

    if "risk_range" in assertions:
        checks.append(response["risk_level"] in assertions["risk_range"])
        weights.append(3.0)

    if "content_pattern" in assertions:
        checks.append(bool(re.search(assertions["content_pattern"], response["content"])))
        weights.append(2.0)

    # ... other assertion checks ...

    if not weights:
        return 1.0
    return sum(w * c for w, c in zip(weights, checks)) / sum(weights)
```

**Error type handling**: All errors score `0.0`. Returning `None` from a DSPy metric is not reliably supported, so `provider_error` also scores `0.0` rather than trying to skip. The distinct error types are still valuable: they're logged separately for post-hoc analysis (e.g., if 10% of calls failed due to rate limits, you know to adjust concurrency, not the instruction).

Removed: `strip_fences()`, JSON parse hard gates, enum validation, `FENCE_PENALTY`. These are now handled by the bridge's Zod validation.

#### 3e. Custom eval loop after optimization

```python
def bridge_evaluate(val_examples, instruction, demos, schema_text):
    scores = []
    for ex in val_examples:
        response, error_type = call_bridge_execute(
            instruction=instruction,
            demos=demos,
            schema_text=schema_text,
            memory=ex.memory,
            tools_output=ex.tools_output,
            cwd=ex.cwd,
            piped=ex.piped,
            query=ex.natural_language_query,
        )
        if error_type is not None:
            scores.append(0.0)
        else:
            scores.append(score(response, ex.assertions))
    avg = sum(scores) / len(scores) if scores else 0.0
    print(f"Bridge eval: {avg:.3f} ({len(scores)} examples)")
    return avg
```

**Why custom eval loop instead of `dspy.Evaluate`?** The winning candidate must be validated through the bridge (real TS prompt assembly + real LLM execution). `dspy.Evaluate` would route through DSPy's own evaluation framework. Our custom loop gives full control and directly measures what matters.

#### 3f. Remove remaining Python duplication

Delete from `optimize.py`:
- `memory_to_context()` function (bridge does context formatting now)
- The old `write_output()` that generates TypeScript source (replaced in step 1e)

Keep `DEFAULT_MEMORY`, `DEFAULT_TOOLS_OUTPUT`, `DEFAULT_CWD` — these are still used by `examples_to_dspy()` (step 3c) to fill in defaults for examples that don't specify them. They're example defaults, not prompt constants.

Note: inline prompt constant definitions (section headers, instructions) were already moved to `prompt.constants.json` in step 1e.

Keep:
- `read_schema.py` (extracts schema text from .ts file)
- MIPRO orchestration (train/val split, optimizer configuration, execution)
- `make_signature()` (DSPy signature creation — still needed for MIPRO's teacher)

#### 3g. Dockerfile update

Multi-stage build with both Python and Bun:

```dockerfile
FROM oven/bun:1 AS bun-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY src/ src/
RUN bun install --frozen-lockfile

FROM python:3.12-slim
WORKDIR /app

# Install Bun runtime
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Python deps
COPY eval/dspy/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bun deps + TS source (from first stage)
COPY --from=bun-deps /app/node_modules node_modules/
COPY --from=bun-deps /app/src src/

# Python source
COPY eval/dspy/*.py eval/dspy/

# Bridge script
COPY eval/bridge.ts eval/

ENTRYPOINT ["python", "eval/dspy/optimize.py"]
```

**Why multi-stage?** Bun installs node_modules (AI SDK, Zod) in the first stage — these are Linux binaries, built inside Docker (not mounted from macOS host). Python installs in the second stage. Hermetic and reproducible. Avoids platform-mismatch issues with native modules.

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
| TS refactor shape | `formatContext` + `buildPrompt` + `assembleCommandPrompt` wrapper | Each function has one job. Pure core is injectable. Wrapper preserves runtime ergonomics. |
| Step 1 scope | Combined TS + Python | JSON artifact requires both sides to switch at once. No intermediate broken state. |
| Docker setup | Multi-stage (Bun + Python) | Hermetic. Linux binaries built in Docker. No host platform leakage. |
| Post-optimization eval | Custom bridge eval loop | Direct measurement of bridge-scored performance. Full control. Not coupled to DSPy's Evaluate. |
| Metric adaptation | `score(dict)` takes validated dicts only | Bridge always validates. No raw text scoring needed. Simpler metric. |
| Prompt hash | Computed once by Python, covers both JSON files | Hash versions the full prompt surface (constants + optimized data). Never recomputed at runtime. Read-only for logging/caching. |

## Risks and open questions

### Bun subprocess reliability at scale

~400 subprocess spawns during a single optimization run. If any spawn fails (resource limits, file descriptor exhaustion), the optimization run could break. **Mitigation**: Wrap bridge calls in try/catch with clear error reporting. The subprocess model is simple and each call is independent. If reliability becomes a real issue, evolve to a long-running server (v2).

### DSPy compatibility with custom `forward()`

Overriding `WrapPredictor.forward()` to call the bridge bypasses DSPy's internal `Predict` module. MIPRO expects standard module behavior. Need to verify: demo bootstrapping still works, instruction compilation still works, the teacher model can still propose candidates. **Mitigation**: Test with a small optimization run before full adoption.

### AI SDK structured output differences

The bridge uses Vercel AI SDK's structured output (native JSON mode). DSPy uses its own output parsing. Edge cases may differ. **Not a concern**: We explicitly chose bridge-scored results as the source of truth. What matters is how the prompt performs through the real execution path.

### Docker image size

Adding Bun + node_modules increases image size from ~200MB to ~400-500MB. **Acceptable**: Dev-only tool, not shipped to users.

### Prompt hash computation

`promptHash` is a SHA-256 hash covering the full prompt surface: all fields from both `prompt.constants.json` and `prompt.optimized.json`. Python computes it once at the end of optimization by building an ordered manifest of all prompt fragments (instruction, constants, schema text, demos) and hashing the compact JSON representation. The hash is written into `prompt.optimized.json`. Runtime reads the hash for logging/cache-invalidation purposes but never recomputes it. This preserves the "compute once, consume many times" model.

### Thread history

`buildPrompt` doesn't support `threadHistory` (multi-round conversations). Not needed now — multi-round is not yet implemented in runtime. Add the parameter when the feature lands.

### DSPy signature field changes

DSPy Examples now store raw data (memory dict, tools, cwd) instead of pre-formatted `memory_context` string. MIPRO's teacher model may see raw JSON when inspecting examples for instruction proposal. Teacher is Claude Sonnet — it understands JSON. Monitor instruction quality; if it degrades, consider a formatting step for teacher-visible fields.

## Acceptance criteria

The implementation is done when:

- Runtime prompt assembly is driven by pure `buildPrompt()` + `formatContext()` core functions
- Runtime behavior is identical to before the refactor (same prompts, same execution)
- `prompt.optimized.ts` is deleted; runtime reads from `prompt.constants.json` + `prompt.optimized.json`
- Eval bridge can assemble prompts using the exact runtime message structure (`assemble` mode)
- DSPy candidate evaluation goes through the bridge, not `dspy.LM` for the target model call
- Eval bridge does not retry malformed outputs
- Python scoring still grades type/risk/content/memory assertions against validated response dicts
- Optimized prompt output is a JSON artifact consumed by runtime
- `promptHash` covers both JSON files, is written once during optimization, and is never recomputed at runtime

## Assumptions and defaults

- **v1 bridge is per-call subprocess.** Matches current runtime boundary. Can evolve to long-running server if overhead becomes a problem.
- **Eval bridge never retries.** Malformed output is optimization signal, not something to repair.
- **JSON artifact is the final format.** Data artifact, not code artifact.
- **Static constants live in a shared JSON file.** Neither language owns them. Changed by hand, committed to git.
- **Python owns optimized instruction/demo data and writes the artifact.** DSPy produces the winning candidate.
- **Provider config for eval is always explicit and Docker-local.** Eval must not depend on user Wrap runtime config.
- **Bridge protocol is stdin/stdout JSON.** Designed so it can later become a long-lived worker with the same request/response shape.
