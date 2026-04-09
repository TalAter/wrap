import { ERASE_LINE, HIDE_CURSOR, SHOW_CURSOR } from "./ansi.ts";
import { chromeRaw } from "./output.ts";
import { isOutputIntercepted } from "./output-sink.ts";

// Two-cell braille frames so the spinner sits in a fixed slot inside the
// dialog's bottom border without shifting the trailing dashes each tick.
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms

/** Default label for the chrome spinner shown around LLM calls. */
export const SPINNER_TEXT = "thinking...";

// One-time crash guard: if the process exits while a spinner is running
// (Ctrl-C, uncaught throw, anything that bypasses the stop() finally), the
// terminal is left with `HIDE_CURSOR` still in effect — invisible cursor
// until the user runs `tput cnorm`. We register process listeners on first
// spinner start that unconditionally write `SHOW_CURSOR` on the way out.
let exitGuardInstalled = false;
function ensureExitGuard(): void {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  const restore = () => {
    if (process.stderr.isTTY) process.stderr.write(SHOW_CURSOR);
  };
  process.on("exit", restore);
  // Signals don't fire `exit` until the default handler runs, and the default
  // handler exits with the signal's conventional code. Re-emit the signal
  // after restoring the cursor so the user's shell sees the right exit code.
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
}

/** Reset the exit-guard install flag — for tests only. */
export function resetExitGuard(): void {
  exitGuardInstalled = false;
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
 * On first call, installs a one-time process exit/SIGINT/SIGTERM listener
 * that restores the cursor if the process dies before stop() runs.
 *
 * No-op when stderr is not a TTY — keeps `\r` garbage out of redirected logs.
 * Also no-op while output is intercepted — the dialog renders its own
 * spinner in the bottom border, and a second one writing raw `\r` frames
 * to stderr would flicker into the alt-screen render.
 */
export function startChromeSpinner(text: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  if (isOutputIntercepted()) return () => {};

  ensureExitGuard();

  // Precompute the full per-frame string once. `text` is fixed for the
  // lifetime of the spinner, so the per-tick render is one array lookup
  // and one syscall — no template-literal allocation.
  const lines = SPINNER_FRAMES.map((f) => `\r${f} ${text}`);
  let index = 0;
  let stopped = false;
  const tick = () => {
    const line = lines[index] as string;
    index = (index + 1) % lines.length;
    chromeRaw(line);
  };
  // Combine the cursor-hide + first frame into a single write so the spinner
  // appears in one syscall instead of two.
  chromeRaw(`${HIDE_CURSOR}${lines[0] as string}`);
  index = 1 % lines.length;
  const handle = setInterval(() => {
    if (stopped) return;
    tick();
  }, SPINNER_INTERVAL);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    chromeRaw(`\r${ERASE_LINE}${SHOW_CURSOR}`);
  };
}
