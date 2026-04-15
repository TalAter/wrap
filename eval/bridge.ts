/**
 * Bun eval bridge — called by Python optimizer as a subprocess.
 * Reads JSON from stdin, writes JSON to stdout.
 *
 * Two modes:
 *   assemble — build prompt only, return PromptInput
 *   execute  — build prompt, call LLM once, return validated response
 */
import { NoObjectGeneratedError } from "ai";
import { CommandResponseSchema } from "../src/command-response.schema.ts";
import { loadConfig } from "../src/config/config.ts";
import { applyModelOverride } from "../src/config/resolve.ts";
import { buildPromptScaffold } from "../src/llm/build-prompt.ts";
import { formatContext } from "../src/llm/format-context.ts";
import { initProvider } from "../src/llm/index.ts";
import { resolveProvider } from "../src/llm/resolve-provider.ts";
import type { PromptInput } from "../src/llm/types.ts";
import promptConstants from "../src/prompt.constants.json";

function out(value: object): void {
  console.log(JSON.stringify(value));
}

function tryParseJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const input = JSON.parse(await Bun.stdin.text());

const contextString = formatContext({
  memory: input.memory,
  tools: input.tools,
  cwdFiles: input.cwdFiles,
  cwd: input.cwd,
  piped: input.piped,
  pipedInput: input.pipedInput,
  maxPipedInputChars: input.maxPipedInputChars,
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
    pipedInputInstruction: input.pipedInput ? promptConstants.pipedInputInstruction : undefined,
    fewShotExamples: input.fewShotExamples,
    fewShotSeparator: promptConstants.fewShotSeparator,
    sectionUserRequest: promptConstants.sectionUserRequest,
  },
  contextString,
  input.query,
);

const promptInput: PromptInput = {
  system: scaffold.system,
  messages: [...scaffold.prefixMessages, { role: "user", content: scaffold.initialUserText }],
};

// Multi-turn: append extra messages (e.g. probe response + output) after the initial prompt
if (input.extraMessages) {
  for (const msg of input.extraMessages) {
    promptInput.messages.push({ role: msg.role, content: msg.content });
  }
}

// Last round: append the "do not probe" instruction as a separate user message
if (input.lastRound) {
  promptInput.messages.push({
    role: "user",
    content: promptConstants.lastRoundInstruction,
  });
}

if (input.mode === "assemble") {
  out({ ok: true, promptInput });
  process.exit(0);
}

// Execute mode: call LLM once (no retry — malformed output is optimization signal)
const config = loadConfig();
let provider: ReturnType<typeof initProvider>;
try {
  const normalized = applyModelOverride(
    config,
    { flags: new Set(), values: new Map() },
    process.env,
  );
  const resolved = resolveProvider(normalized);
  provider = initProvider(resolved);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

try {
  const response = await provider.runPrompt(promptInput, CommandResponseSchema);
  out({ ok: true, response });
} catch (error) {
  // AI SDK: NoObjectGeneratedError carries raw LLM text
  if (NoObjectGeneratedError.isInstance(error)) {
    const rawText = error.text ?? "";
    out({
      ok: false,
      error: tryParseJson(rawText) ? "invalid_schema" : "invalid_json",
      rawText,
      message: String(error),
    });
  } else if (error instanceof SyntaxError) {
    // JSON.parse failure (e.g. test provider)
    out({ ok: false, error: "invalid_json", message: String(error) });
  } else if (error != null && typeof error === "object" && "issues" in error) {
    // ZodError from schema.parse (e.g. test provider)
    out({ ok: false, error: "invalid_schema", message: String(error) });
  } else {
    // Network, auth, or other provider failure
    out({ ok: false, error: "provider_error", message: String(error) });
  }
}

// AI SDK HTTP clients keep connections alive, preventing Bun from exiting.
// Force exit after output is written so the Python subprocess doesn't hang.
process.exit(0);
