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

/** 0 = no color, 1 = 16-color ANSI, 2 = 256-color, 3 = 24-bit truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

const TRUECOLOR_ENV_VARS = [
  "KITTY_WINDOW_ID",
  "WT_SESSION",
  "ALACRITTY_LOG",
  "ALACRITTY_SOCKET",
  "KONSOLE_VERSION",
  "WEZTERM_EXECUTABLE",
];
const TRUECOLOR_TERM_PROGRAMS = new Set(["iTerm.app", "vscode", "ghostty", "WezTerm", "Hyper"]);
const LOW_COLOR_TERMS = new Set(["linux", "vt100", "vt220", "vt320", "ansi", "cons25"]);

let cachedLevel: ColorLevel | null = null;

export function colorLevel(): ColorLevel {
  if (cachedLevel !== null) return cachedLevel;
  cachedLevel = computeColorLevel();
  return cachedLevel;
}

/** Test-only. Resets the memoized level so per-test env mutations take effect. */
export function __resetColorLevelCache(): void {
  cachedLevel = null;
}

function computeColorLevel(): ColorLevel {
  if ("NO_COLOR" in process.env) return 0;

  // FORCE_COLOR clamps to [0,3]; empty/non-numeric → 1 (chalk convention).
  if ("FORCE_COLOR" in process.env) {
    const n = Number.parseInt(process.env.FORCE_COLOR ?? "", 10);
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

  for (const k of TRUECOLOR_ENV_VARS) if (k in process.env) return 3;

  const tp = process.env.TERM_PROGRAM;
  if (tp && TRUECOLOR_TERM_PROGRAMS.has(tp)) return 3;

  const vte = Number.parseInt(process.env.VTE_VERSION ?? "", 10);
  if (Number.isFinite(vte) && vte >= 3600) return 3;

  if (/-256(color)?/.test(term)) return 2;
  if (LOW_COLOR_TERMS.has(term)) return 1;
  return 2;
}

/**
 * Stdout-targeted predicate: animate only when the user hasn't opted out
 * (config.noAnimation folds CLI flag, WRAP_NO_ANIMATION, CI, TERM=dumb,
 * and NO_COLOR at resolve time) and stdout is an interactive TTY.
 *
 * Per-stream spinners (e.g. chrome spinner on stderr) check `stream.isTTY`
 * directly since TTY status varies per channel.
 */
export function shouldAnimate(): boolean {
  if (getConfig().noAnimation) return false;
  return isTTY();
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
