import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../llm/types.ts";
import { parseDetectedTools, runProbes } from "./init-probes.ts";
import { INIT_SYSTEM_PROMPT } from "./init-prompt.ts";

export type MemoryEntry = { fact: string };

const MEMORY_FILE = "memory.json";

/** Load memory entries from disk. Returns [] if file doesn't exist. Throws on corrupt JSON. */
export function loadMemory(wrapHome: string): MemoryEntry[] {
  const path = join(wrapHome, MEMORY_FILE);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error("Memory error: could not read memory.json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Memory error: memory.json contains invalid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Memory error: memory.json must contain a JSON array");
  }

  return parsed as MemoryEntry[];
}

/** Write memory entries to disk. Creates directory lazily. */
export function saveMemory(wrapHome: string, entries: MemoryEntry[]): void {
  mkdirSync(wrapHome, { recursive: true });
  const path = join(wrapHome, MEMORY_FILE);
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

/** Append new entries to existing memory on disk. */
export function appendMemory(wrapHome: string, newEntries: MemoryEntry[]): void {
  const existing = loadMemory(wrapHome);
  saveMemory(wrapHome, [...existing, ...newEntries]);
}

/** Parse LLM init response (one fact per line) into MemoryEntry[]. */
export function parseInitResponse(response: string): MemoryEntry[] {
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
export async function ensureMemory(provider: Provider, wrapHome: string): Promise<MemoryEntry[]> {
  const existing = loadMemory(wrapHome);
  if (existing.length > 0) return existing;

  process.stderr.write("✨ Learning about your system...\n");

  const probeOutput = runProbes();
  const response = await provider.runPrompt(INIT_SYSTEM_PROMPT, probeOutput);
  const entries = parseInitResponse(response);

  saveMemory(wrapHome, entries);

  process.stderr.write(`${buildSummary(probeOutput)}\n`);

  return entries;
}
