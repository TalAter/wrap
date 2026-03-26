import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chrome } from "../core/output.ts";
import { prettyPath } from "../core/paths.ts";
import type { Provider } from "../llm/types.ts";
import { parseDetectedTools, runProbes } from "./init-probes.ts";
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

/** Append new entries to the global "/" scope on disk. */
export function appendMemory(wrapHome: string, newEntries: Fact[]): void {
  const memory = loadMemory(wrapHome);
  const existing = memory["/"] ?? [];
  memory["/"] = [...existing, ...newEntries];
  saveMemory(wrapHome, memory);
}

/** Parse LLM init response (one fact per line) into Fact[]. */
export function parseInitResponse(response: string): Fact[] {
  return response
    .split("\n")
    .map((line) => line.trim().replace(/^[-•]\s*/, ""))
    .filter((line) => line.length > 0)
    .map((fact) => ({ fact }));
}

/** Build the summary line shown after init (e.g. "Detected OS, shell, git, docker, ..."). */
function buildSummary(probeOutput: string): string {
  // Extract just the "Core tools" section from probe output
  const coreToolsSection = probeOutput.split("## Core tools\n")[1] ?? "";
  const tools = parseDetectedTools(coreToolsSection.split("\n\n")[0]);
  const parts = ["OS", "shell", ...tools];
  return `🧠 Detected ${parts.join(", ")}`;
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

  chrome(buildSummary(probeOutput));

  return memory;
}
