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
 * Lazy-load Ink + React + Dialog. Idempotent. The session kicks this off
 * in parallel with the first LLM call so by the time the first dialog
 * mount is needed, the modules are already loaded — `mountDialog` is then
 * synchronous.
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
 * Mount the Ink dialog synchronously. Throws if `preloadDialogModules()`
 * hasn't resolved at least once.
 */
export function mountDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost {
  if (!cached) {
    throw new Error("mountDialog: preloadDialogModules() must resolve first");
  }
  const { ink, react, Dialog } = cached;
  const app = ink.render(react.createElement(Dialog, props), {
    stdout: process.stderr,
    patchConsole: false,
    alternateScreen: true,
  });
  return {
    rerender(nextProps) {
      app.rerender(react.createElement(Dialog, nextProps));
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
