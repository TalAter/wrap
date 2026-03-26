# LLM SDK Integration

Adds direct API provider support via the Vercel AI SDK (`ai` v6 + `@ai-sdk/anthropic` + `@ai-sdk/openai`), starting with Anthropic and OpenAI. Native structured output, uniform interface across providers, easy future expansion to Google/Ollama by adding a config case + `bun add @ai-sdk/<provider>`.

---

## 1. Provider Interface Redesign

**File:** `src/llm/types.ts`

The provider has a single LLM-calling method: `runPrompt`. It takes a `PromptInput` and an optional Zod schema. Without a schema it returns plain text; with a schema it returns a validated, typed object. The provider doesn't know about memory, prompt optimization, or Wrap-specific concerns — the caller assembles everything.

`runCommandPrompt` is **not on the provider** — it's a standalone function in `src/llm/index.ts` that calls `provider.runPrompt(input, CommandResponseSchema)`. This keeps schema awareness outside the provider.

```ts
type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

type PromptInput = {
  system: string;                    // always exactly one system prompt
  messages: ConversationMessage[];   // conversation turns: few-shot, probes, thread history, current prompt
};

interface Provider {
  runPrompt(input: PromptInput, schema?: ZodType<unknown>): Promise<unknown>;
}

/** Wrap's structured command/answer/probe call. Convenience over provider.runPrompt(). */
function runCommandPrompt(provider: Provider, input: PromptInput): Promise<CommandResponse> {
  return provider.runPrompt(input, CommandResponseSchema) as Promise<CommandResponse>;
}
```

The interface uses a single signature with optional `schema`. Callers that know the schema type (like `runCommandPrompt`) cast the return. This avoids TypeScript overload issues with object literal implementations — every provider is a plain object with one `runPrompt` function.

**Why system is separate from messages:**
- System prompt is always exactly one, conceptually different from turns
- Maps directly to the AI SDK's `generateText({ system, messages })` — no extraction hack
- CLI providers get a clean system string to pass as `--system-prompt`
- Messages are pure conversation turns — no role mixing

**Multi-turn via messages array:**
- Probes: after a probe response, append `{role: "assistant", probeJSON}` + `{role: "user", probeResult}` and call again
- Few-shot: each demo becomes a `user`/`assistant` turn pair
- Thread continuation (out of scope — defined but not implemented): load previous thread messages and prepend
- Retry: append the failed response + error context as new turns

**Who assembles the PromptInput:** `src/llm/context.ts` (see §4). The provider receives a pre-assembled `PromptInput` and just calls the LLM.

---

## 2. Rename: ResponseSchema → CommandResponseSchema

**File:** `src/response.schema.ts` → `src/command-response.schema.ts`

The Zod schema for Wrap's command/answer/probe structured response is renamed to clarify its purpose now that `runPrompt` accepts arbitrary schemas:

- `ResponseSchema` → `CommandResponseSchema`
- `Response` type → `CommandResponse`
- `ResponseJsonSchema` → `CommandResponseJsonSchema`

Grep for all `response.schema` imports and update. Known importers: `core/parse-response.ts`, `logging/entry.ts`, `llm/providers/claude-code.ts`, `tests/response.schema.test.ts`. Also update `prompt.optimized.ts` exports and DSPy extraction script (`eval/dspy/read_schema.py`) — the `SCHEMA_START`/`SCHEMA_END` markers stay the same, only the export names change inside.

---

## 3. Config Schema Extension

**Files:** `src/llm/providers/ai-sdk.ts`, `src/config/config.schema.json`

One config type for all AI SDK-supported providers. The `type` discriminant determines which SDK factory to use; the shape is identical across providers.

```ts
type AISDKProviderConfig = {
  type: "anthropic" | "openai";  // extend as needed: "google", etc.
  model?: string;    // default varies by type (e.g. "claude-sonnet-4-latest", "gpt-4o-mini")
  apiKey?: string;   // "$ENV_VAR" → resolves from env. Literal → used as-is. Omitted → AI SDK reads provider's default env var
  baseURL?: string;  // custom endpoint — works for all providers (Ollama, proxies, etc.)
};
```

API key resolution (inline in `src/llm/providers/ai-sdk.ts`):
1. Omitted → return `undefined` (let the AI SDK read its default env var, e.g. `ANTHROPIC_API_KEY`). Zero config for users who already have the standard env var in their shell profile.
2. `"$MY_KEY"` → `process.env["MY_KEY"]`. Throws a clear config error if the env var is not set.
3. Literal string → used as-is. Plaintext in `~/.wrap/config.jsonc` — same security posture as a `.env` file or any other dotfile credential store.

Config examples:
```jsonc
// Anthropic (minimal — reads ANTHROPIC_API_KEY from env)
{ "provider": { "type": "anthropic" } }

// Anthropic (reads MY_ANTH_KEY from env)
{ "provider": { "type": "anthropic", "apiKey": "$MY_ANTH_KEY" } }

// OpenAI with explicit model and API key
{ "provider": { "type": "openai", "model": "gpt-4o", "apiKey": "sk-aefde31..." } }

// Ollama via OpenAI-compatible endpoint
{ "provider": { "type": "openai", "model": "llama3", "baseURL": "http://localhost:11434/v1" } }
```

---

## 4. Context Assembly

**New file:** `src/llm/context.ts`

Refactor `buildSystemPrompt()` out of `src/llm/providers/claude-code.ts` and generalize. Returns a `PromptInput` — system prompt string + conversation turn array.

```ts
type Fact = { fact: string };
type Memory = Record<string, Fact[]>;

type QueryContext = {
  prompt: string;
  cwd: string;                              // resolved via resolvePath() once at startup
  memory: Memory;                           // full map; assembleCommandPrompt filters by CWD prefix
  threadHistory?: ConversationMessage[];    // out of scope — defined but not implemented
  pipedInput?: string;                      // out of scope — defined but not implemented
};

/** Assemble a PromptInput for a command prompt call. */
function assembleCommandPrompt(ctx: QueryContext): PromptInput {
  // system: static instructions + schema (cacheable prefix)
  // messages: few-shot demos, separator, then thread history, then context + user prompt
}
```

Ordering is designed for cache efficiency (static prefix first) and contamination prevention (few-shot demos separated from real context).

**System prompt (static, cacheable):**
- `SYSTEM_PROMPT` from `prompt.optimized.ts`
- Schema text from `prompt.optimized.ts`

**Messages (in order):**
1. Few-shot demos as user/assistant turn pairs (static, cacheable)
2. Separator: `{ role: "user", content: "Now handle the following request." }` — marks the boundary between examples and the real conversation. Prevents the LLM from treating thread history or context as more examples and prevents examples from contaminating the real request
3. Thread history turns (if continuing)
4. Final user message — context block + user prompt in a single message:
   ```
   ## System facts
   Facts are listed oldest-first. If two facts contradict, the later one is more current.
   - fact1
   - fact2

   ## Facts about /Users/tal/monorepo
   - uses bun
   - run tests with `bun run test`

   - Working directory (cwd): /Users/tal/monorepo

   ## User's request
   <user's actual prompt>
   ```

Memory facts and cwd go in the final user message (not the system prompt) because they're dynamic per-request. This keeps the system prompt + few-shot prefix fully static and cacheable. The turn boundary between the last few-shot assistant response and the next user message provides natural separation — few-shot examples end, real request begins.

Make sure that updates to the structure are also replicated exactly in DSPy.

---

## 5. AI SDK Provider

**New file:** `src/llm/providers/ai-sdk.ts`
**Packages:** `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`

`aiSdkProvider(config)` takes an `AISDKProviderConfig`, creates the right SDK model internally, and returns a `Provider`. All SDK-specific complexity (factory functions, default models, key resolution) stays hidden inside. `resolveApiKey()` is also defined here (it's a small utility only used by this file).

Static imports for all provider packages. Wrap is a run-once CLI — the startup cost of importing a few small packages is negligible, and static imports keep `initProvider` synchronous and the code simpler.

```ts
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-latest",
  openai: "gpt-4o-mini",
};

const MODEL_FACTORIES: Record<string, (config: AISDKProviderConfig) => LanguageModel> = {
  anthropic: (c) => createAnthropic({ apiKey: resolveApiKey(c.apiKey), baseURL: c.baseURL })(c.model ?? DEFAULT_MODELS.anthropic),
  openai: (c) => createOpenAI({ apiKey: resolveApiKey(c.apiKey), baseURL: c.baseURL })(c.model ?? DEFAULT_MODELS.openai),
};

function aiSdkProvider(config: AISDKProviderConfig): Provider {
  const factory = MODEL_FACTORIES[config.type];
  if (!factory) throw new Error(`Config error: unsupported AI SDK provider "${config.type}".`);
  const model = factory(config);

  return {
    runPrompt: async ({ system, messages }, schema?) => {
      if (schema) {
        const result = await generateText({
          model, system, messages,
          output: Output.object({ schema }),
        });
        if (result.output === undefined) {
          throw new Error("LLM returned no structured output.");
        }
        return result.output;
      }
      const result = await generateText({ model, system, messages });
      return result.text;
    },
  };
}

function resolveApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("$")) {
    const envVar = value.slice(1);
    const resolved = process.env[envVar];
    if (!resolved) throw new Error(`Config error: environment variable ${envVar} is not set.`);
    return resolved;
  }
  return value;
}
```

`initProvider()` is synchronous, just routing — no SDK details:

```ts
function initProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
    case "openai":
      return aiSdkProvider(config);
    case "claude-code":
      return claudeCodeProvider(config);
    case "test":
      return testProvider();
  }
}
```

Adding a new AI SDK provider (e.g., Google Gemini) = extend the `AISDKProviderConfig.type` union + add an entry to `MODEL_FACTORIES` + `bun add @ai-sdk/google`. No new files, no changes to `initProvider()` besides another `case` in the `switch`.

---

## 6. Structured Output Retry (§8.2)

**Location:** `src/core/query.ts` — at the call site, provider-agnostic.

If `runCommandPrompt` throws a structured output error, retry once with the failed output appended as context + a stricter instruction. Clone messages before retry to avoid mutating the caller's array (important when retry happens inside a probe loop).

```ts
import { NoObjectGeneratedError } from "ai";

function isStructuredOutputError(e: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(e) ||
    (e instanceof Error && (e.message.includes("invalid JSON") || e.message.includes("invalid response")))
  );
}

function extractFailedText(e: unknown): string {
  if (NoObjectGeneratedError.isInstance(e)) return e.text ?? "";
  return "";
}

// In runQuery:
try {
  response = await runCommandPrompt(provider, input);
} catch (e) {
  if (!isStructuredOutputError(e)) throw e;
  const retryInput = {
    system: input.system,
    messages: [
      ...input.messages,
      { role: "assistant" as const, content: extractFailedText(e) },
      { role: "user" as const, content: "Your response was not valid JSON. Respond ONLY with valid JSON matching the schema." },
    ],
  };
  response = await runCommandPrompt(provider, retryInput);
}
```

---

## 7. Adapt Existing Providers

### `claude-code.ts`
- `runPrompt({ system, messages }, schema?)` — pass `system` as `--system-prompt`, flatten messages into the user prompt string, shell out to `claude` CLI
- Without schema → return stdout string
- With schema → pass `--json-schema`, parse raw output via `parseResponse()`, validate against schema, return typed object
- **Message flattening:** concatenate user/assistant turns with role markers (e.g., `User: ...\nAssistant: ...\n`) into a single string for the `-p` flag. Few-shot demos, probe history, and retry turns all go through this serialization.

### `test.ts`
- Without schema → return `WRAP_TEST_RESPONSE` or last user message content
- With schema → parse `WRAP_TEST_RESPONSE` as JSON, validate against schema, return typed object

---

## 8. Wire Up

### `src/llm/index.ts` (initProvider + runCommandPrompt)
- `initProvider`: add `case "anthropic"` and `case "openai"` → `aiSdkProvider(config)`
- `runCommandPrompt`: standalone function that calls `provider.runPrompt(input, CommandResponseSchema)`

### `src/core/query.ts` (runQuery)
- Build `PromptInput` via `assembleCommandPrompt(ctx)` from context.ts
- Call `runCommandPrompt(provider, input)` → get typed `CommandResponse` directly
- Remove external `parseResponse()` call
- Add retry wrapper (§6)
- Probe loop: on probe response, append probe result as turns to `input.messages`, call again

### `src/memory/memory.ts` (ensureMemory)
- `provider.runPrompt({ system: INIT_SYSTEM_PROMPT, messages: [{ role: "user", content: probeOutput }] })`

### `src/main.ts`
- `const provider = initProvider(config.provider)` (stays synchronous)
- Pass `cwd` and env context to `runQuery` for context assembly

---

## 9. Files Changed / Created

| File | Action | What |
|------|--------|------|
| `src/llm/types.ts` | modify | `ConversationMessage`, `PromptInput`, new `Provider` interface (single `runPrompt` with optional schema). Provider config types move to their provider files — `types.ts` just imports and unions them into `ProviderConfig`. |
| `src/response.schema.ts` | rename+modify | → `src/command-response.schema.ts`. `ResponseSchema` → `CommandResponseSchema`, `Response` → `CommandResponse` |
| `src/llm/context.ts` | **create** | `assembleCommandPrompt()` — context assembly |
| `src/llm/index.ts` | modify | `initProvider` dispatch + `runCommandPrompt()` convenience function |
| `src/llm/providers/ai-sdk.ts` | **create** | Single AI SDK provider, `resolveApiKey()`, model factories. Exports `AISDKProviderConfig`. |
| `src/llm/providers/claude-code.ts` | modify | Adapt to `PromptInput` + optional schema interface. Message flattening for CLI. Exports own `ClaudeCodeProviderConfig`. |
| `src/llm/providers/test.ts` | modify | Adapt to `PromptInput` + optional schema interface. Exports own `TestProviderConfig`. |
| `src/core/query.ts` | modify | Use context assembly, `runCommandPrompt()`, retry logic with clone |
| `src/core/parse-response.ts` | modify | Update imports for rename |
| `src/logging/entry.ts` | modify | Update `Response` → `CommandResponse` import |
| `src/memory/memory.ts` | modify | Use `PromptInput`-based `runPrompt` |
| `src/main.ts` | modify | Pass context to query |
| `src/config/config.schema.json` | modify | Add anthropic + openai provider schemas |
| `src/prompt.optimized.ts` | modify | Update exports for rename |
| `eval/dspy/read_schema.py` | modify | Update for renamed exports |
| `tests/` | modify+create | New + updated tests throughout |

---

## 10. Implementation Order (TDD)

Each step: write failing test first, then implement.

1. **Rename** — `ResponseSchema` → `CommandResponseSchema`, `Response` → `CommandResponse`. Rename file. Update all imports including `parse-response.ts`, `prompt.optimized.ts`, DSPy script, tests.
2. **Types + Config** — `ConversationMessage`, `PromptInput`, `AISDKProviderConfig`. Move existing config types to provider files. Update config schema JSON.
3. **Provider interface** — Change `Provider` to single `runPrompt` with optional schema. Update test provider + its tests first (everything depends on it).
4. **Context assembly** — `src/llm/context.ts` + tests. `assembleCommandPrompt` builds system string + conversation turns.
5. **Claude-code provider** — Adapt to new interface, message flattening, update tests.
6. **Update query.ts + memory.ts + main.ts** — Wire new interface through. Add `runCommandPrompt` to `index.ts`. Update e2e tests. Everything should pass with test + claude-code providers at this point.
7. **Install AI SDK** — `bun add ai @ai-sdk/anthropic @ai-sdk/openai`
8. **AI SDK provider** — Implement `ai-sdk.ts` with mocked `generateText` tests.
9. **Retry logic** — Structured output retry in `query.ts` + tests (clone messages, error detection).
10. **Clean up** — Remove dead code, `bun run check`.

---

## Open Questions

1. **Schema text in system prompt**: For API providers with native structured output, embedding schema text in the system prompt is redundant but still helps the LLM understand field semantics. Starting simple — always include it. Can optimize later.
2. **Few-shot + structured output**: Few-shot assistant turns contain raw JSON. Need to verify this works well with `Output.object()`. If it causes issues with structured output enforcement, fall back to embedding demos in system prompt.
3. **Separator message**: The "Now handle the following request." separator between few-shot demos and real conversation is a prompt engineering hypothesis. Should be validated via eval — if it hurts or doesn't help, remove it.
