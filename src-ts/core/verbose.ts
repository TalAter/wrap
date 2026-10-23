import { getConfig } from "../config/store.ts";
import { dim } from "./ansi.ts";
import { emit } from "./notify.ts";

let startTime = 0;

function prefix(): string {
  if (!startTime) startTime = performance.now();
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  return dim(`» [+${elapsed}s] `);
}

/** Emit a verbose line through the notification bus if enabled; no-op if disabled. */
export function verbose(msg: string): void {
  if (!getConfig().verbose) return;
  emit({ kind: "verbose", line: `${prefix()}${dim(msg)}\n` });
}

/**
 * Like verbose(), but the highlight portion is rendered at normal brightness.
 * Used for the LLM response line where command content stands out.
 */
export function verboseHighlight(msg: string, highlight: string): void {
  if (!getConfig().verbose) return;
  emit({ kind: "verbose", line: `${prefix()}${dim(msg)}${highlight}\n` });
}

/** Reset state — for tests only. */
export function resetVerboseTimer(): void {
  startTime = 0;
}
