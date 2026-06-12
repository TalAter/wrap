import type { Llm } from "wrap-core/llm";
import { z } from "zod";
import { chrome } from "../core/output.ts";
import { prettyPath, resolvePath } from "../core/paths.ts";
import { verbose } from "../core/verbose.ts";
import { wrapFs } from "../fs/home.ts";
import { INIT_SYSTEM_PROMPT } from "./init-prompt.ts";
import { runProbes } from "./memory-init-probes.ts";
import { countFacts, type Memory } from "./types.ts";

const MEMORY_FILE = "memory.json";

const FactSchema = z.object({ fact: z.string() });
const MemoryFileSchema = z.record(z.string(), z.array(FactSchema));

/** Load memory from disk. Returns {} if file doesn't exist. Throws on corrupt/invalid file. */
export function loadMemory(): Memory {
  const raw = wrapFs.read(MEMORY_FILE);
  if (raw === null) return {};

  const path = wrapFs.resolve(MEMORY_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw memoryError(path);
  }

  const result = MemoryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw memoryError(path);
  }

  return result.data;
}

function memoryError(filePath: string): Error {
  return new Error(
    `Memory error: ${prettyPath(filePath)} is broken — delete the file and run Wrap again.`,
  );
}

/** Write memory to disk. Creates directory lazily. Sorts keys alphabetically. */
export function saveMemory(memory: Memory): void {
  const sorted: Memory = {};
  for (const [key, value] of Object.entries(memory).sort(([a], [b]) => a.localeCompare(b))) {
    sorted[key] = value;
  }
  wrapFs.write(MEMORY_FILE, JSON.stringify(sorted, null, 2));
}

/**
 * Resolve scopes, append facts to the correct scope, persist, and return updated Memory.
 * Discards facts whose scope doesn't resolve to an existing directory.
 */
export function appendFacts(updates: Array<{ fact: string; scope: string }>, cwd: string): Memory {
  const memory = loadMemory();
  for (const { fact, scope } of updates) {
    const resolved = resolvePath(scope, cwd);
    if (resolved === null) continue;
    const existing = memory[resolved] ?? [];
    if (!existing.some((e) => e.fact === fact)) {
      memory[resolved] = [...existing, { fact }];
    }
  }
  saveMemory(memory);
  return memory;
}

/**
 * Typed shape of the init send — replaces the old one-fact-per-line parsing.
 * The transform keeps the old line-parser's hygiene: sloppy model output must
 * not persist empty or untrimmed facts to memory.json forever.
 */
const InitFactsSchema = z.object({
  facts: z.array(z.string()).transform((fs) => fs.map((s) => s.trim()).filter(Boolean)),
});

/**
 * Load existing memory or initialize by probing the system and asking the
 * LLM. Init is a one-send conversation: the probe dump is the single user
 * message, and the facts arrive through the send's typed result.
 * `initialized` reports whether the init send actually ran — main.ts uses
 * it to keep the legacy query loop's test-playback cursor aligned while the
 * old and new LLM machineries coexist.
 */
export async function ensureMemory(llm: Llm): Promise<{ memory: Memory; initialized: boolean }> {
  const existing = loadMemory();
  if (Object.keys(existing).length > 0) {
    const total = countFacts(existing);
    const globalCount = (existing["/"] ?? []).length;
    verbose(`Memory: ${total} facts (${globalCount} global, ${total - globalCount} scoped)`);
    return { memory: existing, initialized: false };
  }

  chrome("Learning about your system...", "✨");

  verbose("Init: probing OS and shell...");
  const probeOutput = runProbes();
  verbose("Init: calling LLM to extract system facts...");
  // `retry: false` preserves the legacy exactly-one-physical-call semantics —
  // and keeps shared WRAP_TEST_RESPONSES consumption deterministic while the
  // query loop still runs the legacy provider machinery. Revisit at the
  // main-loop flip.
  const chat = llm.startConversation({ system: INIT_SYSTEM_PROMPT });
  chat.add({ role: "user", content: probeOutput });
  let facts: string[];
  try {
    ({ facts } = await chat.send(InitFactsSchema, { retry: false }));
  } catch (e) {
    // Send failures (provider, parse) propagate to main's catch — prefixed
    // here so the user-facing message keeps wrap's voice (vault invariant 3).
    // LlmConfigError can't reach this catch: createLlm validates eagerly, and
    // initLlm prefixes those with "Config error:" at its own site.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`LLM error (${llm.label}): ${message}`);
  }
  verbose(`Init: ${facts.length} facts extracted`);
  const memory: Memory = { "/": facts.map((fact) => ({ fact })) };

  saveMemory(memory);

  chrome("Detected OS and shell", "🧠");

  return { memory, initialized: true };
}
