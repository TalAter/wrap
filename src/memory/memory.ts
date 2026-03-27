import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chrome } from "../core/output.ts";
import { prettyPath, resolvePath } from "../core/paths.ts";
import type { Provider } from "../llm/types.ts";
import { runProbes } from "./init-probes.ts";
import { INIT_SYSTEM_PROMPT } from "./init-prompt.ts";

import type { Fact, Memory } from "./types.ts";

const MEMORY_FILE = "memory.json";

const FactSchema = z.object({ fact: z.string() });
const MemoryFileSchema = z.record(z.string(), z.array(FactSchema));

/** Load memory from disk. Returns {} if file doesn't exist. Throws on corrupt/invalid file. */
export function loadMemory(wrapHome: string): Memory {
  const path = join(wrapHome, MEMORY_FILE);
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw memoryError(path);
  }

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
export function saveMemory(wrapHome: string, memory: Memory): void {
  mkdirSync(wrapHome, { recursive: true });
  const sorted: Memory = {};
  for (const key of Object.keys(memory).sort()) {
    sorted[key] = memory[key];
  }
  const path = join(wrapHome, MEMORY_FILE);
  writeFileSync(path, JSON.stringify(sorted, null, 2));
}

/**
 * Resolve scopes, append facts to the correct scope, persist, and return updated Memory.
 * Discards facts whose scope doesn't resolve to an existing directory.
 */
export function appendFacts(
  wrapHome: string,
  updates: Array<{ fact: string; scope: string }>,
  cwd: string,
): Memory {
  const memory = loadMemory(wrapHome);
  for (const { fact, scope } of updates) {
    const resolved = resolvePath(scope, cwd);
    if (resolved === null) continue;
    const existing = memory[resolved] ?? [];
    memory[resolved] = [...existing, { fact }];
  }
  saveMemory(wrapHome, memory);
  return memory;
}

/** Parse LLM init response (one fact per line) into Fact[]. */
export function parseInitResponse(response: string): Fact[] {
  return response
    .split("\n")
    .map((line) => line.trim().replace(/^[-•]\s*/, ""))
    .filter((line) => line.length > 0)
    .map((fact) => ({ fact }));
}

/** Load existing memory or initialize by probing the system and asking the LLM. */
export async function ensureMemory(provider: Provider, wrapHome: string): Promise<Memory> {
  const existing = loadMemory(wrapHome);
  if (Object.keys(existing).length > 0) return existing;

  chrome("✨ Learning about your system...");

  const probeOutput = runProbes();
  const response = await provider.runPrompt({
    system: INIT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: probeOutput }],
  });
  const facts = parseInitResponse(response as string);
  const memory: Memory = { "/": facts };

  saveMemory(wrapHome, memory);

  chrome("🧠 Detected OS and shell");

  return memory;
}
