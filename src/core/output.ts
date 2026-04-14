import { getConfig } from "../config/store.ts";
import { emit } from "./notify.ts";

export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

/**
 * Color is safe when the user hasn't opted out via NO_COLOR (no-color.org)
 * and stdout is an interactive TTY (or FORCE_COLOR overrides the TTY check).
 */
export function supportsColor(): boolean {
  if ("NO_COLOR" in process.env) return false;
  if ("FORCE_COLOR" in process.env) return process.env.FORCE_COLOR !== "0";
  return isTTY();
}

/**
 * 0 = no color, 1 = 16-color ANSI, 2 = 256-color, 3 = 24-bit truecolor.
 *
 * COLORTERM is the de-facto signal for truecolor but is dropped by
 * ssh/sudo/tmux; fall back to parsing TERM for the 256-color suffix.
 */
export type ColorLevel = 0 | 1 | 2 | 3;

export function colorLevel(): ColorLevel {
  // NO_COLOR always wins (no-color.org)
  if ("NO_COLOR" in process.env) return 0;

  // FORCE_COLOR overrides TTY detection. Values: 0=off, 1=16, 2=256, 3=truecolor.
  // Numeric values are clamped to [0,3]. Empty / non-numeric → 1.
  if ("FORCE_COLOR" in process.env) {
    const raw = process.env.FORCE_COLOR ?? "";
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) {
      if (n <= 0) return 0;
      if (n >= 3) return 3;
      return n as ColorLevel;
    }
    return 1;
  }

  if (!isTTY()) return 0;
  const term = process.env.TERM ?? "";
  if (term === "dumb") return 0;
  const ct = process.env.COLORTERM;
  if (ct === "truecolor" || ct === "24bit") return 3;
  if (/-256(color)?/.test(term)) return 2;
  return 1;
}

/**
 * Motion on top of color requires an interactive session where the
 * redraw is actually watched. CI logs replay frames as garbage, dumb
 * terminals can't move the cursor, and screen-reader / low-motion
 * users signal via WRAP_NO_MOTION.
 */
export function shouldAnimate(opts?: { enabled?: boolean }): boolean {
  if (opts?.enabled === false) return false;
  if (getConfig().noAnimation) return false;
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

// ── Nerd Fonts ─────────────────────────────────────────────────────

/**
 * Return `icon` when Nerd Fonts are enabled, otherwise `fallback`.
 * Callers own coloring — this is pure string resolution.
 */
export function resolveIcon(icon: string, fallback = ""): string {
  return getConfig().nerdFonts ? icon : fallback;
}

export function isNerdFonts(): boolean {
  return getConfig().nerdFonts === true;
}
