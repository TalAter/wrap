import { ERASE_LINE, HIDE_CURSOR, SHOW_CURSOR } from "./ansi.ts";
import { chromeRaw } from "./output.ts";

// Two-cell braille frames so the spinner sits in a fixed slot inside the
// dialog's bottom border without shifting the trailing dashes each tick.
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms

/** Default label for the chrome spinner shown around LLM calls. */
export const SPINNER_TEXT = "thinking...";

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
