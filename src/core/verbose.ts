import { dim } from "./ansi.ts";

let enabled = false;
let initialized = false;
let startTime = 0;

/** Called once from main.ts after config loads. */
export function initVerbose(enable: boolean): void {
  if (initialized) throw new Error("initVerbose() called more than once");
  initialized = true;
  enabled = enable;
  if (enable) startTime = performance.now();
}

function prefix(): string {
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  return dim(`» [+${elapsed}s] `);
}

/** Emit a verbose line to stderr if enabled; no-op if disabled. */
export function verbose(msg: string): void {
  if (!enabled) return;
  process.stderr.write(`${prefix()}${dim(msg)}\n`);
}

/**
 * Like verbose(), but the highlight portion is rendered at normal brightness.
 * Used for the LLM response line where command content stands out.
 */
export function verboseHighlight(msg: string, highlight: string): void {
  if (!enabled) return;
  process.stderr.write(`${prefix()}${dim(msg)}${highlight}\n`);
}

/** Reset state — for tests only. */
export function resetVerbose(): void {
  enabled = false;
  initialized = false;
  startTime = 0;
}
