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
 * ssh/sudo/tmux/docker; we sniff known emulator env vars too. TERM is
 * unreliable — modern terminals routinely report bare "xterm" while actually
 * supporting 256+ colors (esp. inside docker), so we promote modern bare
 * TERMs to 256 and only treat genuine 8/16-color types (linux, vt100) as 1.
 */
export type ColorLevel = 0 | 1 | 2 | 3;

// Modern terminal-emulator env vars that imply truecolor support. None of
// these are set except by the emulator itself, so no false positives.
const TRUECOLOR_ENV_VARS = [
  "KITTY_WINDOW_ID",
  "WT_SESSION",
  "ALACRITTY_LOG",
  "ALACRITTY_SOCKET",
  "KONSOLE_VERSION",
  "WEZTERM_EXECUTABLE",
];
const TRUECOLOR_TERM_PROGRAMS = new Set(["iTerm.app", "vscode", "ghostty", "WezTerm", "Hyper"]);
// TERM types that are genuinely 8/16-color even on modern systems.
const LOW_COLOR_TERMS = new Set(["linux", "vt100", "vt220", "vt320", "ansi", "cons25"]);

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

  for (const k of TRUECOLOR_ENV_VARS) if (k in process.env) return 3;

  const tp = process.env.TERM_PROGRAM;
  if (tp && TRUECOLOR_TERM_PROGRAMS.has(tp)) return 3;

  // gnome-terminal / tilix / etc set VTE_VERSION; truecolor since ~3600.
  const vte = Number.parseInt(process.env.VTE_VERSION ?? "", 10);
  if (Number.isFinite(vte) && vte >= 3600) return 3;

  if (/-256(color)?/.test(term)) return 2;
  if (LOW_COLOR_TERMS.has(term)) return 1;
  // Bare modern TERMs (xterm, screen, tmux, rxvt, alacritty, kitty, ghostty,
  // foot, wezterm) commonly omit -256color but still support it.
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
