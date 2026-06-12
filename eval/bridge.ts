/**
 * Bun eval bridge — called by Python optimizer as a subprocess.
 * Reads JSON from stdin, writes JSON to stdout.
 *
 * Two modes:
 *   assemble — build prompt only, return PromptInput
 *   execute  — build prompt, call LLM once, return validated response
 *
 * Both modes run on wrap-core's conversation abstraction. The stdout shapes
 * (`ok` / `invalid_json` / `invalid_schema` / `provider_error`, and the
 * assemble-mode `promptInput`) are a cross-language contract with
 * `eval/dspy/optimize.py` — keep them stable.
 */
import { createLlm, type Llm, LlmParseError } from "wrap-core/llm";
import { z } from "zod";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
import { loadConfig } from "../src/config/config.ts";
import { applyModelOverride } from "../src/config/resolve.ts";
import type { Transcript } from "../src/core/transcript.ts";
import { buildPromptInput } from "../src/core/transcript.ts";
import { buildPromptScaffold } from "../src/llm/build-prompt.ts";
import { formatContext } from "../src/llm/format-context.ts";
import { initLlm } from "../src/llm/llm-config.ts";
import { resolveProvider } from "../src/llm/resolve-provider.ts";
import type { ConversationMessage, PromptInput } from "../src/llm/types.ts";
import promptConstants from "../src/prompt.constants.json";

// Strict so stale callers (e.g. seed.jsonl still carrying `tools`/`cwdFiles`)
// fail loudly instead of silently degrading the eval signal.
const BridgeInputSchema = z
  .object({
    mode: z.enum(["assemble", "execute"]),
    instruction: z.string(),
    fewShotExamples: z.array(z.object({ input: z.string(), output: z.string() })),
    schemaText: z.string(),
    memory: z.record(z.string(), z.array(z.object({ fact: z.string() }))),
    cwd: z.string(),
    piped: z.boolean(),
    query: z.string(),
    extraMessages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
      .optional(),
    lastRound: z.boolean().optional(),
    attachedInputPath: z.string().optional(),
    attachedInputSize: z.number().optional(),
    attachedInputPreview: z.string().optional(),
    attachedInputTruncated: z.boolean().optional(),
  })
  .strict();

function out(value: object): void {
  console.log(JSON.stringify(value));
}

/**
 * Recover the assembled request through core's own machinery: drive a
 * test-provider conversation whose canned response never parses, send once
 * with retry disabled, and read the request off the sealed entry's attempt
 * forensics. Assemble mode thereby reports what a real send would carry —
 * core's assembly, not a parallel local reconstruction.
 */
async function assembleRequest(promptInput: PromptInput): Promise<PromptInput> {
  const llm = createLlm({ name: "test", responses: "assemble probe (never parses)" });
  const chat = llm.startConversation({ system: promptInput.system });
  for (const message of promptInput.messages) chat.add(message);
  try {
    await chat.send(CommandResponseSchema, { retry: false });
  } catch (e) {
    // Expected: the canned response is deliberately unparseable, so only the
    // parse failure is swallowed. Anything else is a core regression and must
    // not silently degrade assemble output.
    if (!(e instanceof LlmParseError)) throw e;
  }
  const request = chat.entries.at(-1)?.attempts?.[0]?.request;
  if (!request) throw new Error("assemble failed: conversation recorded no attempt.");
  return {
    system: request.system,
    messages: request.messages as ConversationMessage[],
  };
}

let input: z.infer<typeof BridgeInputSchema>;
try {
  input = BridgeInputSchema.parse(JSON.parse(await Bun.stdin.text()));
} catch (e) {
  // Loud failure: probe state (tools, cwdFiles) used to be context-block
  // sections; the discovery skill now emits them as transcript turns, so
  // eval examples must encode them via `extraMessages`. Unknown top-level
  // fields are rejected so stale callers can't silently degrade eval signal.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const contextString = formatContext({
  memory: input.memory,
  cwd: input.cwd,
  piped: input.piped,
  attachedInputPath: input.attachedInputPath,
  attachedInputSize: input.attachedInputSize,
  attachedInputPreview: input.attachedInputPreview,
  attachedInputTruncated: input.attachedInputTruncated,
  constants: promptConstants,
});

const scaffold = buildPromptScaffold(
  {
    instruction: input.instruction,
    schemaText: input.schemaText,
    schemaInstruction: promptConstants.schemaInstruction,
    memoryRecencyInstruction: promptConstants.memoryRecencyInstruction,
    toolsScopeInstruction: promptConstants.toolsScopeInstruction,
    voiceInstructions: promptConstants.voiceInstructions,
    tempDirPrinciple: promptConstants.tempDirPrinciple,
    finalFlagInstruction: promptConstants.finalFlagInstruction,
    wrapNoteInstruction: promptConstants.wrapNoteInstruction,
    attachedInputInstruction:
      input.attachedInputPreview !== undefined
        ? promptConstants.attachedInputInstruction
        : undefined,
    fewShotExamples: input.fewShotExamples,
    fewShotSeparator: promptConstants.fewShotSeparator,
    sectionUserRequest: promptConstants.sectionUserRequest,
  },
  contextString,
);

// Seed the transcript: `extraMessages` carries everything that came BEFORE
// the current user query — prior user/assistant turns from past rounds and
// simulated skill emissions (discovery's pwd/ls/which, commit's
// status/diff). `input.query` is always the latest user turn and is pushed
// LAST so it sits at the end of the transcript. Mirrors runtime where
// `seedFirstUserTurn` splices skill turns in before the user prompt and
// where prior-round turns naturally precede the new user message.
//
// Step-shaped user messages (those projected from a `kind: "step"` turn,
// which start with the `## Captured output` section header) are mapped
// back to step turns so `buildPromptInput`'s first-user-turn framing skips
// them — the framing must wrap a real user request, not a captured probe
// output. Without this remap, e.g. a discovery skill simulation
// `[assistant which, user "## Captured output..."]` would have framing
// attach to the captured-output turn instead of `input.query`.
const STEP_PREFIX = `${promptConstants.sectionCapturedOutput}\n`;
const transcript: Transcript = [];
if (Array.isArray(input.extraMessages)) {
  for (const msg of input.extraMessages) {
    if (msg.role === "user") {
      if (msg.content.startsWith(STEP_PREFIX)) {
        const output = msg.content.slice(STEP_PREFIX.length);
        transcript.push({
          kind: "step",
          command: "",
          exit_code: 0,
          output,
          shell: "",
          source: "model",
        });
      } else {
        transcript.push({ kind: "user", text: msg.content });
      }
    } else if (msg.role === "assistant") {
      // The harness sends raw JSON command-response text; parse it back so
      // the assistant turn projects through `projectResponseForEcho`.
      const parsed = JSON.parse(msg.content);
      transcript.push({
        kind: "assistant",
        response: parsed,
        attempts: [],
        source: "model",
      });
    }
  }
}
transcript.push({ kind: "user", text: input.query });

const promptInput = buildPromptInput(transcript, scaffold, {
  liveContext: undefined,
  isLastRound: input.lastRound === true,
  requestFraming: {
    contextString,
    sectionUserRequest: promptConstants.sectionUserRequest,
  },
});

if (input.mode === "assemble") {
  out({ ok: true, promptInput: await assembleRequest(promptInput) });
  process.exit(0);
}

// Execute mode: call LLM once (retry: false — malformed output is the
// optimization signal, so the in-send parse retry must stay off).
let llm: Llm;
try {
  const config = loadConfig();
  const normalized = applyModelOverride(
    config,
    { flags: new Set(), values: new Map() },
    process.env,
  );
  // initLlm surfaces core config errors in wrap's voice ("Config error: …").
  llm = initLlm(resolveProvider(normalized));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

try {
  const chat = llm.startConversation({ system: promptInput.system });
  for (const message of promptInput.messages) chat.add(message);
  const response = await chat.send(CommandResponseSchema, { retry: false });
  out({ ok: true, response });
} catch (error) {
  if (error instanceof LlmParseError) {
    // send's own classification — never re-derived by re-parsing rawText.
    out({ ok: false, error: error.reason, rawText: error.rawText, message: String(error) });
  } else {
    // Network, auth, or other provider failure
    out({ ok: false, error: "provider_error", message: String(error) });
  }
}

// AI SDK HTTP clients keep connections alive, preventing Bun from exiting.
// Force exit after output is written so the Python subprocess doesn't hang.
process.exit(0);
