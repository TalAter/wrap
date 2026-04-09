import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SHOW_CURSOR } from "../core/ansi.ts";
import { chromeRaw } from "../core/output.ts";
import type { AppEvent, AppState } from "./state.ts";

export type DialogHost = {
  rerender(props: { state: AppState; dispatch: (e: AppEvent) => void }): void;
  unmount(): void;
};

type DialogModules = {
  ink: typeof import("ink");
  react: typeof import("react");
  Dialog: typeof import("../tui/dialog.tsx").Dialog;
};

let cached: DialogModules | null = null;

/**
 * Lazy-load the Ink + React + Dialog modules. Idempotent — first call does
 * the dynamic imports and caches them; subsequent calls resolve immediately.
 * The session calls this once at startup (in parallel with the first LLM
 * call) so by the time the first dialog mount is needed, the modules are
 * already loaded. Allows `mountDialog` itself to be synchronous.
 */
export async function preloadDialogModules(): Promise<void> {
  if (cached) return;
  const [ink, react, dialogModule] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/dialog.tsx"),
  ]);
  cached = { ink, react, Dialog: dialogModule.Dialog };
}

/**
 * Synchronously mount the Ink dialog. Enters alt screen, renders, returns
 * a host handle. Caller (the session) owns the lifecycle.
 *
 * MUST be called only after `preloadDialogModules()` has resolved at least
 * once — throws otherwise. The session enforces this via the `inkReady`
 * promise it awaits before the first mount.
 *
 * The session is responsible for the no-TTY case BEFORE calling — when
 * `runLoop` returns a medium/high command and `process.stderr.isTTY` is
 * false, the coordinator dispatches `block` instead of `loop-final`. The
 * reducer transitions `thinking → exiting{blocked}` and the dialog never
 * sees a dialog state. mountDialog itself is never called without a TTY.
 */
export function mountDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost {
  if (!cached) {
    throw new Error("mountDialog: preloadDialogModules() must resolve first");
  }
  const { ink, react, Dialog } = cached;
  chromeRaw(ENTER_ALT_SCREEN);
  const app = ink.render(react.createElement(Dialog, props), {
    stdout: process.stderr,
    patchConsole: false,
  });
  return {
    rerender(nextProps) {
      app.rerender(react.createElement(Dialog, nextProps));
    },
    unmount() {
      app.unmount();
      chromeRaw(`${EXIT_ALT_SCREEN}${SHOW_CURSOR}`);
    },
  };
}

/** Test-only — clear the lazy module cache. */
export function resetDialogHostCache(): void {
  cached = null;
}
