import { type Notification, notifications, writeNotificationToStderr } from "../core/notify.ts";
import type { DialogHost } from "./dialog-host.ts";

/**
 * Routes notifications between three sinks based on whether the dialog is
 * mounted and whether the session is in a "live" dialog state:
 *
 *   - **No dialog**: write straight to stderr. This is the path for
 *     `thinking`, `exiting`, and any state where the dialog hasn't mounted
 *     yet or has already unmounted. Chrome lines from the initial loop's
 *     steps/memory updates land in real scrollback as they happen.
 *
 *   - **Dialog mounted**: buffer for replay after unmount. Without buffering,
 *     stderr writes during alt-screen would land in the alt buffer and
 *     disappear on exit.
 *
 *   - **Dialog mounted AND `isDialogLive()` (i.e. `processing` or
 *     `executing-step`)**: ALSO call `onDialogNotification` so the
 *     coordinator can dispatch a `notification` event. In `processing`,
 *     the reducer routes chrome → bottom-border status and step-output →
 *     output slot. In `executing-step`, only step-output is meaningful.
 *
 * The router holds the dialog handle and the buffer; the coordinator hands
 * it the dialog after mount and clears it before flush.
 *
 * Lifecycle:
 *
 *   const router = createNotificationRouter({ onProcessingChrome, isProcessing });
 *   const unsubscribe = router.subscribe();
 *   ...
 *   router.setDialog(host);    // after mountDialog
 *   ...
 *   router.teardownDialog();   // before exec / on exit — unmounts + flushes
 *   unsubscribe();
 */
export type NotificationRouterOptions = {
  /**
   * Called for every notification that lands while the dialog is mounted
   * AND `isDialogLive()` returns true. The coordinator dispatches an
   * AppEvent so the reducer can update `status` (chrome) or `outputSlot`
   * (step-output). Other notification kinds are ignored by the reducer.
   */
  onDialogNotification: (n: Notification) => void;
  /**
   * Called once per emit to ask whether the session is in a state that
   * wants live notification updates — currently `processing` or
   * `executing-step`. Pulled rather than pushed so the router doesn't
   * have to mirror the coordinator's state.
   */
  isDialogLive: () => boolean;
};

export type NotificationRouter = {
  /** Subscribe to the global bus. Returns an unsubscribe function. */
  subscribe(): () => void;
  /** Hand the dialog handle to the router after a successful mount. */
  setDialog(host: DialogHost): void;
  /** Whether a dialog is currently mounted. The router is the single source
   *  of truth for this — the coordinator reads through here rather than
   *  tracking its own copy. */
  isDialogMounted(): boolean;
  /** Read the mounted dialog (or null). The coordinator uses this to call
   *  `rerender` when the state tag changes within a dialog window. */
  getDialog(): DialogHost | null;
  /**
   * Unmount the dialog (if any) and flush the buffered notifications to
   * stderr. The unmount exits the alt screen before the flush, so flushed
   * lines land in real scrollback rather than the alt buffer that's about
   * to disappear. Idempotent.
   */
  teardownDialog(): void;
};

export function createNotificationRouter(options: NotificationRouterOptions): NotificationRouter {
  let dialog: DialogHost | null = null;
  const buffered: Notification[] = [];

  function flushBuffered(): void {
    while (buffered.length > 0) {
      const n = buffered.shift();
      if (n) writeNotificationToStderr(n);
    }
  }

  return {
    subscribe(): () => void {
      return notifications.subscribe((n) => {
        if (dialog === null) {
          writeNotificationToStderr(n);
          return;
        }
        buffered.push(n);
        if (options.isDialogLive()) {
          options.onDialogNotification(n);
        }
      });
    },
    setDialog(host: DialogHost): void {
      dialog = host;
    },
    isDialogMounted(): boolean {
      return dialog !== null;
    },
    getDialog(): DialogHost | null {
      return dialog;
    },
    teardownDialog(): void {
      if (dialog === null) return;
      dialog.unmount();
      dialog = null;
      flushBuffered();
    },
  };
}
