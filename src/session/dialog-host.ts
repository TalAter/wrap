import type { AppEvent, AppState } from "./state.ts";

export type DialogHost = {
  rerender(props: { state: AppState; dispatch: (e: AppEvent) => void }): void;
  unmount(): void;
};

type DialogModules = {
  ink: typeof import("ink");
  react: typeof import("react");
  ResponseDialog: typeof import("../tui/response-dialog.tsx").ResponseDialog;
};

let cached: DialogModules | null = null;

/**
 * Lazy-load Ink + React + ResponseDialog. Idempotent. The session kicks
 * this off in parallel with the first LLM call so by the time the first
 * dialog mount is needed, the modules are already loaded and
 * `mountResponseDialog` is synchronous.
 */
export async function preloadDialogModules(): Promise<void> {
  if (cached) return;
  const [ink, react, responseDialogModule] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/response-dialog.tsx"),
  ]);
  cached = { ink, react, ResponseDialog: responseDialogModule.ResponseDialog };
}

/**
 * Mount the Ink command-response dialog synchronously. Throws if
 * `preloadDialogModules()` hasn't resolved at least once.
 */
export function mountResponseDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost {
  if (!cached) {
    throw new Error("mountResponseDialog: preloadDialogModules() must resolve first");
  }
  const { ink, react, ResponseDialog } = cached;
  const app = ink.render(react.createElement(ResponseDialog, props), {
    stdout: process.stderr,
    patchConsole: false,
    alternateScreen: true,
  });
  return {
    rerender(nextProps) {
      app.rerender(react.createElement(ResponseDialog, nextProps));
    },
    unmount() {
      app.unmount();
    },
  };
}

/** Test-only — clear the lazy module cache. */
export function resetDialogHostCache(): void {
  cached = null;
}
