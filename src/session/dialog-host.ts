import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import type { ProviderEntry } from "../config/config.ts";
import type { WizardCallbacks } from "../tui/config-wizard-dialog.tsx";
import type { ModelsDevData } from "../wizard/models-filter.ts";
import type { AppEvent, AppState } from "./state.ts";

export type DialogHost = {
  rerender(props: { state: AppState; dispatch: (e: AppEvent) => void }): void;
  unmount(): void;
};

/**
 * Pick the Node stream Ink should read keystrokes from. When wrap was piped
 * into (`echo x | w …`), `process.stdin` is a drained pipe; Ink's internal
 * `setRawMode` fails on a non-TTY fd and the ensuing error-render path
 * collides on React keys and loops indefinitely (the reconciler reports
 * stack-trace strings as duplicate child keys). Opening `/dev/tty` fresh
 * gives the dialog a real tty for keyboard input regardless of how wrap was
 * invoked. `isTTY` is forced true on the constructed stream because
 * `tty.ReadStream(fd)` doesn't auto-detect it and Ink gates raw-mode support
 * on that flag. Returns `{ stream: process.stdin, fd: null }` when the
 * parent already has a TTY, or when `/dev/tty` can't be opened (headless
 * contexts — Ink will still fail there, but the pre-existing pathology is
 * already observable and not made worse by this helper).
 */
export function chooseDialogStdin(deps?: {
  isTTY?: boolean | undefined;
  tryOpenTty?: () => number;
}): { stream: NodeJS.ReadStream; fd: number | null } {
  const isTTY = deps ? deps.isTTY : process.stdin.isTTY;
  if (isTTY) return { stream: process.stdin, fd: null };
  const open = deps?.tryOpenTty ?? (() => openSync("/dev/tty", "r"));
  try {
    const fd = open();
    const stream = new ReadStream(fd);
    (stream as unknown as { isTTY: boolean }).isTTY = true;
    return { stream: stream as unknown as NodeJS.ReadStream, fd };
  } catch {
    return { stream: process.stdin, fd: null };
  }
}

export type WizardResult = {
  entries: Record<string, ProviderEntry>;
  defaultProvider: string;
  nerdFonts?: boolean;
};

type ResponseModules = {
  ink: typeof import("ink");
  react: typeof import("react");
  ResponseDialog: typeof import("../tui/response-dialog.tsx").ResponseDialog;
  ThemeProvider: typeof import("../tui/theme-context.tsx").ThemeProvider;
};

type WizardModule = {
  ConfigWizardDialog: typeof import("../tui/config-wizard-dialog.tsx").ConfigWizardDialog;
};

let responseCached: ResponseModules | null = null;
let wizardCached: WizardModule | null = null;

// `exitOnCtrlC: false` lets our key-binding layer route Ctrl+C through the
// session reducer (dispatches key-esc — same path as Esc). Ink's default
// `true` short-circuits every useInput listener for Ctrl+C in raw mode
// (ink/build/hooks/use-input.js), so our binding never fires.
export const DIALOG_INK_OPTIONS = {
  stdout: process.stderr,
  patchConsole: false,
  alternateScreen: true,
  exitOnCtrlC: false,
} as const;

/**
 * Lazy-load Ink + React + ResponseDialog. Fired in parallel with the first
 * LLM call so the await before a response dialog mount is free in practice.
 * Does NOT load the config wizard — that lives behind a separate first-run
 * path and is pulled lazily by `mountConfigWizardDialog`.
 */
export async function preloadResponseDialogModules(): Promise<void> {
  if (responseCached) return;
  const [ink, react, responseDialogModule, themeModule] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/response-dialog.tsx"),
    import("../tui/theme-context.tsx"),
  ]);
  responseCached = {
    ink,
    react,
    ResponseDialog: responseDialogModule.ResponseDialog,
    ThemeProvider: themeModule.ThemeProvider,
  };
}

export function mountResponseDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost {
  if (!responseCached) {
    throw new Error("mountResponseDialog: preloadResponseDialogModules() must resolve first");
  }
  const { ink, react, ResponseDialog, ThemeProvider: TP } = responseCached;
  const { stream: stdin, fd: ownedFd } = chooseDialogStdin();
  const app = ink.render(
    react.createElement(TP, null, react.createElement(ResponseDialog, props)),
    {
      ...DIALOG_INK_OPTIONS,
      stdin,
    },
  );
  return {
    rerender(nextProps) {
      app.rerender(react.createElement(TP, null, react.createElement(ResponseDialog, nextProps)));
    },
    unmount() {
      app.unmount();
      if (ownedFd !== null && typeof (stdin as { destroy?: () => void }).destroy === "function") {
        (stdin as { destroy: () => void }).destroy();
      }
    },
  };
}

/**
 * Mount the config wizard in Ink's alt-screen. Ensures the shared response
 * runtime (ink/react/theme) is loaded, then lazy-imports the wizard module
 * on first call — keeps 68KB+ of wizard/animation code out of the hot path
 * where config already exists. Returns `null` on user cancel.
 */
export async function mountConfigWizardDialog(callbacks: {
  fetchModels: () => Promise<ModelsDevData>;
  probeCliBinaries: () => Record<string, boolean>;
}): Promise<WizardResult | null> {
  await preloadResponseDialogModules();
  if (!wizardCached) {
    const m = await import("../tui/config-wizard-dialog.tsx");
    wizardCached = { ConfigWizardDialog: m.ConfigWizardDialog };
  }
  // biome-ignore lint/style/noNonNullAssertion: populated by the awaits above
  const { ink, react, ThemeProvider: TP } = responseCached!;
  const { ConfigWizardDialog } = wizardCached;

  return new Promise<WizardResult | null>((resolve) => {
    const { stream: stdin, fd: ownedFd } = chooseDialogStdin();
    const cleanup = () => {
      app.unmount();
      if (ownedFd !== null && typeof (stdin as { destroy?: () => void }).destroy === "function") {
        (stdin as { destroy: () => void }).destroy();
      }
    };
    const props: WizardCallbacks = {
      ...callbacks,
      onDone: (result) => {
        cleanup();
        resolve(result);
      },
      onCancel: () => {
        cleanup();
        resolve(null);
      },
    };
    const app = ink.render(
      react.createElement(TP, null, react.createElement(ConfigWizardDialog, props)),
      { ...DIALOG_INK_OPTIONS, stdin },
    );
  });
}

/** Test-only — clear both lazy module caches. */
export function resetDialogHostCache(): void {
  responseCached = null;
  wizardCached = null;
}
