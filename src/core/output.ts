import { emit } from "./notify.ts";

export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

/**
 * Color is safe when the user hasn't opted out via NO_COLOR (no-color.org)
 * and stdout is an interactive TTY. Logs, pipes, and `NO_COLOR=` alike
 * must fall back to plain text.
 */
export function supportsColor(): boolean {
  if ("NO_COLOR" in process.env) return false;
  return isTTY();
}

/**
 * Motion on top of color requires an interactive session where the
 * redraw is actually watched. CI logs replay frames as garbage, dumb
 * terminals can't move the cursor, and screen-reader / low-motion
 * users signal via WRAP_NO_MOTION.
 */
export function shouldAnimate(opts?: { enabled?: boolean }): boolean {
  if (opts?.enabled === false) return false;
  if (!supportsColor()) return false;
  if ("CI" in process.env) return false;
  if (process.env.TERM === "dumb") return false;
  if ("WRAP_NO_MOTION" in process.env) return false;
  return true;
}

export function hasJq(): boolean {
  return !!Bun.which("jq");
}

/**
 * Emit a chrome line through the notification bus. With no listener
 * subscribed, the bus writes a formatted line to stderr; with the session
 * subscribed, it routes to the buffer + reducer.
 */
export function chrome(text: string, icon?: string): void {
  emit({ kind: "chrome", text, icon });
}

/** Write raw chrome output to stderr — no trailing newline. For ANSI escapes, partial writes. */
export function chromeRaw(msg: string): void {
  process.stderr.write(msg);
}
