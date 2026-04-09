/**
 * Notification bus — replaces output-sink.ts.
 *
 * Producers (`chrome`, `verbose`, runner memory-update emits) call `emit(n)`.
 * With NO listener subscribed, `emit` writes a default-formatted line to
 * stderr via `writeNotificationToStderr`. With a listener subscribed (the
 * session), the listener decides what to do — buffer for later flush,
 * dispatch to reducer for live display, or both.
 *
 * Module-level state matches the existing pattern in `verbose.ts` and
 * `spinner.ts`. No class, no singleton instance — just functions that close
 * over module-private state. In production there is one subscriber at a
 * time (the active session); the `Set<NotificationListener>` shape supports
 * multiple subscribers because tests need it.
 */

/** Pre-formatted lines emitted by chrome producers. */
export type Notification =
  | { kind: "chrome"; text: string; icon?: string }
  | { kind: "verbose"; line: string }
  | { kind: "step-output"; text: string };

export type NotificationListener = (n: Notification) => void;

const listeners = new Set<NotificationListener>();

/**
 * Emit a notification. With no listener subscribed, writes to stderr via
 * `writeNotificationToStderr`. With listeners subscribed, fans out to all
 * of them; listener exceptions are swallowed so a buggy listener can't
 * crash producers like `chrome()`.
 */
export function emit(n: Notification): void {
  if (listeners.size === 0) {
    writeNotificationToStderr(n);
    return;
  }
  for (const listener of listeners) {
    try {
      listener(n);
    } catch {
      // Listener bugs must not crash producers.
    }
  }
}

/**
 * Subscribe a listener. Returns an unsubscribe function. While at least one
 * listener is subscribed, `emit` does NOT write to stderr — the listener
 * owns the rendering decision.
 */
export function subscribe(listener: NotificationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only — clears all listeners. */
export function resetNotifications(): void {
  listeners.clear();
}

/**
 * Format-and-write a notification to stderr. The default fallback used when
 * no listener is subscribed (or when a subscribed listener delegates here).
 *
 * **`step-output` is intentionally dropped.** That kind carries the
 * post-truncated captured output of an intermediate command (a probe today,
 * a confirmed multi-step in the future). Its only consumer is the dialog's
 * output slot — there is no stderr fallback for it. Writing it to stderr
 * during `thinking` would flood the user's terminal with raw probe output
 * that was already fed to the LLM via the transcript.
 */
export function writeNotificationToStderr(n: Notification): void {
  switch (n.kind) {
    case "chrome": {
      const line = n.icon ? `${n.icon} ${n.text}\n` : `${n.text}\n`;
      process.stderr.write(line);
      return;
    }
    case "verbose":
      process.stderr.write(n.line);
      return;
    case "step-output":
      // Dialog-only — no stderr fallback. See JSDoc above.
      return;
  }
}

/** Convenience namespace re-export. */
export const notifications = { emit, subscribe };
