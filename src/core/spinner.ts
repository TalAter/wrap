import { getConfig } from "../config/store.ts";
import { ERASE_LINE, HIDE_CURSOR, SHOW_CURSOR } from "./ansi.ts";
import { chromeRaw } from "./output.ts";

// Two-cell braille frames so the spinner sits in a fixed slot inside the
// dialog's bottom border without shifting the trailing dashes each tick.
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms

/** Default label for the chrome spinner shown around LLM calls. */
export const SPINNER_TEXT = "thinking...";

// Subscriber registry for "run this on process exit" teardowns. Use cases:
// - Cursor-show (SHOW_CURSOR) when a spinner is still running.
// - Kitty disambiguate-mode pop (\x1b[<u) when compose is still mounted.
// Any code path that flips a terminal mode and would orphan it on abnormal
// exit registers its restoration here. Listeners are installed once, on
// first registration, and each teardown bytes string is written verbatim.
const teardownBytes = new Set<string>();
let listenersInstalled = false;

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const restore = () => {
    if (!process.stderr.isTTY) return;
    for (const bytes of teardownBytes) process.stderr.write(bytes);
  };
  process.on("exit", restore);
  // Signals don't fire `exit` until the default handler runs — which exits
  // with the signal's conventional code. Re-emit after restoring so the
  // user's shell sees the right exit code.
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
}

/**
 * Register a sequence of bytes to write to stderr on process exit. Returns
 * an unregister fn. Safe to call before any spinner or dialog work. Listeners
 * on the process are installed lazily on the first call.
 */
export function registerExitTeardown(bytes: string): () => void {
  installListeners();
  teardownBytes.add(bytes);
  return () => {
    teardownBytes.delete(bytes);
  };
}

// Cursor-show teardown is registered at module init so the spinner's
// existing crash guarantee ("terminal's cursor comes back even on SIGINT")
// continues to hold without a first-spinner-install race.
let cursorTeardownUnregister: (() => void) | null = null;
function ensureCursorTeardown(): void {
  if (cursorTeardownUnregister) return;
  cursorTeardownUnregister = registerExitTeardown(SHOW_CURSOR);
}

/** Reset the exit-guard install flag + clear registrations — for tests only. */
export function resetExitGuard(): void {
  listenersInstalled = false;
  teardownBytes.clear();
  cursorTeardownUnregister = null;
}

/** Test-only alias that also resets the cursor teardown singleton. */
export function _resetExitTeardownRegistryForTests(): void {
  resetExitGuard();
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
 * No-op when stderr is not a TTY — keeps `\r` garbage out of redirected
 * logs. The session ensures this is only called outside the alt-screen
 * window (the dialog has its own bottom-border spinner) by passing
 * `showSpinner: false` from the follow-up loops, so there is no need to
 * gate on whether output is intercepted.
 */
export function startChromeSpinner(text: string): () => void {
  if (!process.stderr.isTTY) return () => {};

  // When animations are disabled, show the status text once (no frame, no
  // cursor hide, no interval) and erase it on stop.
  if (getConfig().noAnimation) {
    chromeRaw(`\r${text}`);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      chromeRaw(`\r${ERASE_LINE}`);
    };
  }

  ensureCursorTeardown();

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
