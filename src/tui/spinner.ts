import { useEffect, useState } from "react";
import { ERASE_LINE, HIDE_CURSOR, SHOW_CURSOR } from "../core/ansi.ts";
import { chromeRaw } from "../core/output.ts";

// Two-cell braille frames so the spinner sits in a fixed slot inside the
// dialog's bottom border without shifting the trailing dashes each tick.
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms

/**
 * React hook that returns the current spinner frame, advancing every
 * `SPINNER_INTERVAL` ms while `active` is true. Returns `null` when inactive
 * so callers narrow on `frame !== null` instead of conflating liveness with
 * the truthiness of a string (an empty/whitespace frame is still a frame).
 */
export function useSpinner(active: boolean): string | null {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => {
      setIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => {
      clearInterval(handle);
    };
  }, [active]);
  if (!active) return null;
  // Index is bounded; the `?? null` satisfies noUncheckedIndexedAccess.
  return SPINNER_FRAMES[index] ?? null;
}

/**
 * Stderr spinner used outside of Ink. Writes `\r` + frame + " " + text on
 * every tick (no newline) so the line is overwritten in place. Hides the
 * cursor while running. The returned stop function clears the spinner line
 * and restores the cursor, so the spinner disappears completely once stopped.
 *
 * `stop` is idempotent — query.ts calls it from a catch block (to clear the
 * row before logging an error) and again from the surrounding finally.
 *
 * No-op when stderr is not a TTY — keeps `\r` garbage out of redirected logs.
 */
export function startChromeSpinner(text: string): () => void {
  if (!process.stderr.isTTY) return () => {};

  let index = 0;
  let stopped = false;
  const renderFrame = (): string => {
    const frame = SPINNER_FRAMES[index] as string;
    index = (index + 1) % SPINNER_FRAMES.length;
    return `\r${frame} ${text}`;
  };
  // Combine the cursor-hide + first frame into a single write so the spinner
  // appears in one syscall instead of two.
  chromeRaw(`${HIDE_CURSOR}${renderFrame()}`);
  const handle = setInterval(() => {
    if (stopped) return;
    chromeRaw(renderFrame());
  }, SPINNER_INTERVAL);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    chromeRaw(`\r${ERASE_LINE}${SHOW_CURSOR}`);
  };
}
