/**
 * Output streams contract — Wrap's I/O discipline (vault README invariant 1).
 *
 * stdout = the command's PRODUCT, nothing else: executed-command output
 *   (the shell child inherits stdout in command mode — shell.ts), the answer
 *   text in answer mode (session.ts), and the deliberate payload of output
 *   subcommands (--help, --log, --version, --completion).
 * stderr / /dev/tty = human NARRATION: chrome status lines, the spinner,
 *   verbose traces, confirmations, errors — all of Wrap's own UI.
 *
 * Why: stdout stays pipeable and composable (`w … | jq`), and the alt-screen
 * dialog buffer stays clean — a stray stdout write during the Ink dialog
 * would corrupt it.
 *
 * What to call:
 *   - chrome(text, icon?)       status line → notify bus → stderr (or dialog)
 *   - chromeRaw(bytes)          raw escapes / partial writes → stderr, no \n
 *   - verbose(msg)              opt-in trace → notify bus → stderr (verbose.ts)
 *   - startChromeSpinner(text)  in-place spinner → stderr, TTY-gated (spinner.ts)
 *   - console.log / stdout.write  ONLY for product — never narration
 *
 * Narration routes through the notify bus (notify.ts) instead of writing
 * stderr directly so the session can intercept it while a dialog is mounted.
 * Anything emitting escapes (spinner, help animation, log colorization) gates
 * on `isTTY` so redirected output never gets cursor/color garbage.
 */

import { isTTY as _isTTY } from "wrap-core/ansi";
import { getConfig } from "../config/store.ts";
import { emit } from "./notify.ts";

// Re-export terminal capability detection from wrap-core/ansi
export {
  __resetColorLevelCache,
  type ColorLevel,
  colorLevel,
  isTTY,
  supportsColor,
} from "wrap-core/ansi";

// ── wrap-specific functions ─────────────────────────────────────

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
  return _isTTY();
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
