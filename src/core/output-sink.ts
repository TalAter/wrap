/**
 * Output sink — captures chrome/verbose writes while the dialog
 * owns the alt screen.
 *
 * Stderr writes during the alt screen would be discarded when we switch
 * back to the main buffer. While `interceptOutput(handler)` is held,
 * `writeLine(line, event?)` buffers the line for replay on `release()`,
 * and — if a chrome event is attached — also hands it to the handler so
 * the dialog can render it live. Verbose lines omit the event and only
 * get the replay treatment.
 *
 * Lifecycle (in render.ts):
 *
 *   chromeRaw(ENTER_ALT_SCREEN);
 *   const release = interceptOutput(handleChrome);
 *   //   ...mount Ink dialog, await waitUntilExit...
 *   chromeRaw(EXIT_ALT_SCREEN);
 *   release();   // MUST be after EXIT_ALT_SCREEN so the flushed lines
 *                // land in real scrollback, not the alt buffer that's
 *                // about to disappear.
 */

/** A chrome line surfaced to the dialog as structured data so it can render the icon and text separately. */
export type ChromeEvent = {
  /** User-facing text without any icon prefix. */
  text: string;
  /** Icon character the producer prepended to `line`, surfaced separately so the dialog can style it. */
  icon?: string;
};

/** Receives chrome events while an interception is active. Verbose lines are NOT delivered here. */
export type ChromeHandler = (event: ChromeEvent) => void;

/**
 * Register a single chrome-event listener. Returns an unsubscribe function.
 * The shape `dialog.tsx` consumes via its `subscribeChrome` prop and
 * `render.ts` provides as a thin wrapper around `interceptOutput`.
 */
export type SubscribeChrome = (listener: ChromeHandler) => () => void;

type Interception = {
  handler: ChromeHandler;
  /** Pre-formatted lines (with icons / ANSI / trailing newlines) replayed on release. */
  buffer: string[];
};

let active: Interception | null = null;

/**
 * Claim the output channel for the dialog. Returns a `release()` function
 * which flushes everything buffered during the interception out to real
 * stderr in original order.
 *
 * Throws if another interception is already active. Throws on double
 * release. Both are programmer errors that would silently lose history.
 */
export function interceptOutput(handler: ChromeHandler): () => void {
  if (active !== null) {
    throw new Error("interceptOutput: another interception is already active");
  }
  active = { handler, buffer: [] };
  return () => {
    if (active === null) {
      throw new Error("interceptOutput: release called twice");
    }
    const pending = active.buffer;
    active = null;
    for (const line of pending) process.stderr.write(line);
  };
}

/**
 * Write a line of output. With no interception active, goes straight to
 * stderr. With an interception active, the line is buffered for the
 * eventual replay on `release()`, and — if `chromeEvent` is provided —
 * the dialog's handler is also called so the message can be shown live.
 */
export function writeLine(line: string, chromeEvent?: ChromeEvent): void {
  if (active === null) {
    process.stderr.write(line);
    return;
  }

  // Buffer before notifying: if the handler throws, the line still
  // replays on release, so scrollback survives dialog bugs.
  active.buffer.push(line);
  if (chromeEvent) {
    try {
      active.handler(chromeEvent);
    } catch {
      // Handler bugs must not crash producers like chrome()/verbose().
    }
  }
}

/** Reset state — for tests only. */
export function resetOutputSink(): void {
  active = null;
}
